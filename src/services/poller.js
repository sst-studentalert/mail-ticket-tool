// Poller: pulls new INBOX (and Sent) messages via each mailbox's provider
// adapter. A message starting a new Gmail thread creates a new ticket; a
// message that's a follow-up in a thread we've already ticketed updates that
// SAME ticket (content + received_at + reopened status) instead of creating
// a duplicate, so a back-and-forth conversation stays one ticket with
// continuous history.
//
// Two ways this runs, depending on deployment:
//   - Always-on process (Docker/Render/local `node src/server.js`): an
//     in-process node-cron schedule calls pollAllMailboxes() every
//     POLL_CRON interval, via startPoller() below. Enabled by setting
//     ENABLE_INTERNAL_POLLER=true.
//   - Vercel (or anywhere serverless): there's no long-running process for
//     node-cron to run in, so a Vercel Cron Job hits POST /api/cron/poll
//     (see src/routes/cron.js) on a schedule instead, which calls
//     pollAllMailboxes() once per invocation. startPoller() is a no-op in
//     that case (ENABLE_INTERNAL_POLLER left false/unset).
const cron = require('node-cron');
const db = require('../db');
const config = require('../config');
const gmailAdapter = require('./gmailAdapter');
const { scoreMessage } = require('./automatedDetection');

// Provider registry: adapter lookup by the mailboxes.provider column, so
// adding e.g. Outlook later is just registering another adapter here.
const PROVIDERS = {
  gmail: gmailAdapter,
};

function providerFor(mailbox) {
  const adapter = PROVIDERS[mailbox.provider];
  if (!adapter) throw new Error(`No adapter registered for provider "${mailbox.provider}"`);
  return adapter;
}

async function logEvent(ticketId, eventType, detail) {
  await db
    .prepare(`INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES (?, NULL, ?, ?)`)
    .run(ticketId, eventType, detail || null);
}

// Records one message (inbound or outbound) against a ticket's thread - see
// the ticket_messages table comment in db.js for why this replaced
// overwriting a single tickets.body field. Idempotent on gmail_message_id
// (via the partial unique index), so re-polling the same Gmail message
// twice - which already happens naturally on every poll cycle - can't
// create duplicate rows.
async function recordMessage(
  ticketId,
  { gmailMessageId, direction, fromAddress, toAddress, ccAddress, body, bodyHtml, sentAt }
) {
  const result = await db
    .prepare(
      `INSERT INTO ticket_messages
        (ticket_id, gmail_message_id, direction, from_address, to_address, cc_address, body, body_html, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gmail_message_id) WHERE gmail_message_id IS NOT NULL DO NOTHING`
    )
    .run(
      ticketId,
      gmailMessageId || null,
      direction,
      fromAddress || null,
      toAddress || null,
      ccAddress || null,
      body || null,
      bodyHtml || null,
      sentAt
    );
  return { inserted: (result.changes || 0) > 0 };
}

// Registers that a given (mailbox, Gmail thread) pair belongs to a ticket -
// see the ticket_thread_links table comment in db.js. Safe to call
// repeatedly for the same pair (e.g. every message in an ongoing thread) -
// the composite primary key makes re-inserts a no-op.
async function linkThread(ticketId, mailboxId, threadId) {
  if (!threadId) return;
  await db
    .prepare(
      `INSERT INTO ticket_thread_links (ticket_id, mailbox_id, gmail_thread_id)
       VALUES (?, ?, ?)
       ON CONFLICT (mailbox_id, gmail_thread_id) DO NOTHING`
    )
    .run(ticketId, mailboxId, threadId);
}

// Finds the ticket (if any) already linked to this exact (mailbox, thread)
// pair - see linkThread/ticket_thread_links. This is how a reply sent from
// a DIFFERENT one of a broadcast's originally-addressed mailboxes still
// resolves back to the same ticket, instead of only ever matching the one
// mailbox the ticket happened to be filed under.
async function findTicketByThreadLink(mailboxId, threadId) {
  if (!threadId) return null;
  return db
    .prepare(
      `SELECT t.* FROM ticket_thread_links l
       JOIN tickets t ON t.id = l.ticket_id
       WHERE l.mailbox_id = ? AND l.gmail_thread_id = ?`
    )
    .get(mailboxId, threadId);
}

// Pulls bare email addresses out of a raw To/Cc header value (which can look
// like `"Name" <a@x.com>, b@y.com, "Other" <c@z.com>`).
function extractEmails(headerValue) {
  if (!headerValue) return [];
  const matches = headerValue.match(/[^\s<>,"]+@[^\s<>,"]+/g);
  return matches ? matches.map((e) => e.toLowerCase()) : [];
}

// When the SAME email is addressed to multiple of our own mailboxes at once
// (one in To with others Cc'd, or several of our mailboxes all in To), Gmail
// delivers a separate copy into each mailbox's own inbox - without this,
// each copy would spawn its own disconnected ticket (see the module comment
// below). This picks ONE mailbox to "own" the resulting ticket, regardless
// of which mailbox's poll happens to process the message first:
//   1. If exactly one of our connected mailboxes is in the To header, that
//      one owns it (it's the addressee; the others were just kept in the
//      loop via Cc).
//   2. Otherwise (several of our mailboxes are all in To, or none are in To
//      at all but at least one is Cc'd), studentalert@ owns it by default
//      if it's one of the matches - it's the primary intake mailbox.
//   3. Failing that, the lowest-id matching mailbox wins, just for a stable,
//      deterministic choice.
// Returns { owner, matched } - matched is every one of our connected
// mailboxes this message was actually addressed to (To or Cc), so the
// caller can note "also addressed to: ..." on the ticket.
function pickOwnerMailbox(message, connectedMailboxes) {
  const toEmails = extractEmails(message.headers && message.headers.to);
  const ccEmails = extractEmails(message.headers && message.headers.cc);

  const toMatches = connectedMailboxes.filter((m) => toEmails.includes(m.email.toLowerCase()));
  const matched = connectedMailboxes.filter(
    (m) => toEmails.includes(m.email.toLowerCase()) || ccEmails.includes(m.email.toLowerCase())
  );

  const candidates = toMatches.length ? toMatches : matched;
  if (candidates.length === 0) return { owner: null, matched };
  if (candidates.length === 1) return { owner: candidates[0], matched };

  const studentAlert = candidates.find((m) => m.email.toLowerCase().startsWith('studentalert'));
  const owner = studentAlert || candidates.slice().sort((a, b) => a.id - b.id)[0];
  return { owner, matched };
}

// Returns { ticketId, created } - created=true if a new ticket row was
// inserted, false if an existing thread's ticket was updated in place (or a
// duplicate copy of an already-ticketed message from a sibling mailbox was
// merged into the existing ticket instead of spawning a new one).
async function createTicketFromMessage(mailbox, message) {
  const existingByMessage = await db
    .prepare('SELECT id FROM tickets WHERE gmail_message_id = ?')
    .get(message.providerMessageId);
  if (existingByMessage) return { ticketId: null, created: false }; // already ticketed, skip

  // One email addressed to several of our mailboxes at once (To + Cc, or
  // several of our addresses all in To) lands as a separate copy in EACH of
  // those mailboxes' inboxes - each with its own provider message/thread id,
  // since they're entirely separate Gmail accounts. Without deduping, that
  // would create one disconnected ticket per mailbox for what's really a
  // single email. The RFC Message-ID header is the one thing every copy of
  // the message shares (Gmail assigns each copy its OWN id/thread per
  // account, but the Message-ID header itself is preserved from the
  // original send). If some other mailbox's copy already got ticketed, fold
  // this copy into that same ticket instead of creating a new one.
  const connectedMailboxes = await db.prepare('SELECT * FROM mailboxes WHERE refresh_token IS NOT NULL').all();
  const { owner, matched } = pickOwnerMailbox(message, connectedMailboxes);

  if (message.messageIdHeader) {
    const existingByHeader = await db
      .prepare('SELECT * FROM tickets WHERE message_id_header = ?')
      .get(message.messageIdHeader);
    if (existingByHeader) {
      await recordMessage(existingByHeader.id, {
        gmailMessageId: message.providerMessageId,
        direction: 'inbound',
        fromAddress: message.from,
        toAddress: message.headers && message.headers.to,
        ccAddress: message.headers && message.headers.cc,
        body: message.bodyText,
        sentAt: message.receivedAt,
      });
      // Registers THIS mailbox's own thread id for the conversation too, so
      // a reply arriving via this mailbox later (inbound OR a Sent-folder
      // reply picked up by detectExternalReply) still resolves back to the
      // same ticket, even though the ticket itself is filed under a
      // different "owning" mailbox.
      await linkThread(existingByHeader.id, mailbox.id, message.providerThreadId);
      await logEvent(
        existingByHeader.id,
        'seen_in_other_mailbox',
        `Same email also landed in ${mailbox.email} (Cc'd/To'd alongside ${
          (matched.find((m) => m.id === existingByHeader.mailbox_id) || {}).email || 'the owning mailbox'
        })`
      );
      return { ticketId: existingByHeader.id, created: false };
    }
  }

  // File the ticket under the resolved owner, not necessarily whichever
  // mailbox's poll happened to process it first - falls back to the current
  // mailbox if header parsing came up empty (e.g. a message with no To/Cc
  // header at all, which shouldn't normally happen).
  const owningMailbox = owner || mailbox;

  const { isAutomated, reasons } = scoreMessage(message);

  // Is this a follow-up in a thread we've already ticketed? Looked up via
  // ticket_thread_links (keyed on THIS mailbox + thread, not the ticket's
  // owning mailbox) so a follow-up arriving through any of the originally-
  // addressed mailboxes resolves back to the same ticket.
  const existingThreadTicket = await findTicketByThreadLink(mailbox.id, message.providerThreadId);

  if (existingThreadTicket) {
    // If the ticket was already sitting in an actionable state (unassigned/
    // assigned), leave status as-is - it's still someone's job to handle it,
    // this new message is just more context. If it had been marked
    // replied/closed, a new inbound message means it needs attention again,
    // so reopen it back to assigned (kept with its existing assignee) or
    // unassigned if nobody's on it.
    const reopening = ['replied', 'closed'].includes(existingThreadTicket.status);
    const newStatus = reopening
      ? existingThreadTicket.assignee_id
        ? 'assigned'
        : 'unassigned'
      : existingThreadTicket.status;

    await db
      .prepare(
        `UPDATE tickets SET
           gmail_message_id = ?, message_id_header = ?, from_address = ?, subject = ?,
           snippet = ?, body = ?, received_at = ?, status = ?,
           is_automated = ?, automated_reason = ?, automated_source = 'auto',
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        message.providerMessageId,
        message.messageIdHeader || null,
        message.from,
        message.subject,
        message.snippet,
        message.bodyText,
        message.receivedAt,
        newStatus,
        isAutomated ? 1 : 0,
        reasons.length ? reasons.join('; ') : null,
        existingThreadTicket.id
      );

    await logEvent(
      existingThreadTicket.id,
      reopening ? 'thread_reopened' : 'thread_new_message',
      `New message in thread (${message.providerMessageId})`
    );

    await recordMessage(existingThreadTicket.id, {
      gmailMessageId: message.providerMessageId,
      direction: 'inbound',
      fromAddress: message.from,
      toAddress: message.headers && message.headers.to,
      ccAddress: message.headers && message.headers.cc,
      body: message.bodyText,
      sentAt: message.receivedAt,
    });
    await linkThread(existingThreadTicket.id, mailbox.id, message.providerThreadId);

    return { ticketId: existingThreadTicket.id, created: false };
  }

  const info = await db
    .prepare(
      `INSERT INTO tickets
        (mailbox_id, gmail_thread_id, gmail_message_id, message_id_header,
         from_address, subject, snippet, body, received_at, first_received_at, status,
         is_automated, automated_reason, automated_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?, ?, 'auto')
       RETURNING id`
    )
    .run(
      owningMailbox.id,
      message.providerThreadId,
      message.providerMessageId,
      message.messageIdHeader || null,
      message.from,
      message.subject,
      message.snippet,
      message.bodyText,
      message.receivedAt,
      message.receivedAt,
      isAutomated ? 1 : 0,
      reasons.length ? reasons.join('; ') : null
    );

  await recordMessage(info.lastInsertRowid, {
    gmailMessageId: message.providerMessageId,
    direction: 'inbound',
    fromAddress: message.from,
    toAddress: message.headers && message.headers.to,
    ccAddress: message.headers && message.headers.cc,
    body: message.bodyText,
    sentAt: message.receivedAt,
  });
  // Links THIS mailbox's thread id (which may not be owningMailbox's, if a
  // non-owner's copy happened to be processed first) so it, and any future
  // reply through it, resolves back to this ticket.
  await linkThread(info.lastInsertRowid, mailbox.id, message.providerThreadId);

  // Surface it when this email was addressed to more than one of our
  // mailboxes at once, so it's clear on the ticket why it landed under
  // owningMailbox specifically instead of looking like a one-off choice.
  if (matched.length > 1) {
    await logEvent(
      info.lastInsertRowid,
      'multi_mailbox_address',
      `Also addressed to: ${matched
        .filter((m) => m.id !== owningMailbox.id)
        .map((m) => m.email)
        .join(', ')}`
    );
  }

  return { ticketId: info.lastInsertRowid, created: true };
}

// Checks the mailbox's Sent folder for outgoing messages and, for any whose
// thread matches a ticket we already know about, records that message into
// ticket_messages regardless of the ticket's current status - a thread can
// keep getting outbound replies (e.g. a staff member forwarding it to a
// colleague) well after the FIRST reply already flipped it to "replied", and
// those later messages deserve to show up in the conversation too, not just
// the first one. On top of that recording, if the ticket is STILL in an
// actionable state (unassigned/assigned - i.e. nobody's marked it handled
// yet), this also auto-marks it replied. This is how a reply sent directly
// from Gmail (bypassing this tool) still gets picked up, instead of relying
// on someone remembering to click "Mark replied externally". If the reply
// was actually sent *through* this tool, the ticket's status is already
// 'replied' by the time this runs, so the status-flip part is naturally a
// no-op for those (no double-processing) - recordMessage's own
// gmail_message_id dedup keeps the message-recording part a no-op too.
//
// Looked up via ticket_thread_links rather than tickets.mailbox_id, so a
// reply sent from a DIFFERENT one of a broadcast's originally-addressed
// mailboxes than whichever one the ticket happened to default to (e.g. a
// mail addressed to studentalert@/career.desk@/disciplinarycommittee@
// together defaults to studentalert@, but disciplinary committee is the one
// who actually replies) still gets matched. When that happens, the ticket
// is transferred to the replying mailbox - the act of replying is a much
// stronger signal of who's actually handling it than our default guess
// was, and leaving it filed under the wrong mailbox would also make it
// invisible to anyone whose access is scoped to just the real owner.
async function detectExternalReply(mailbox, sentMessage) {
  const ticket = await findTicketByThreadLink(mailbox.id, sentMessage.providerThreadId);
  if (!ticket) return false;

  await recordMessage(ticket.id, {
    gmailMessageId: sentMessage.providerMessageId,
    direction: 'outbound',
    fromAddress: sentMessage.from,
    body: sentMessage.bodyText,
    sentAt: sentMessage.receivedAt,
  });

  if (ticket.mailbox_id !== mailbox.id) {
    const previousMailbox = await db.prepare('SELECT email FROM mailboxes WHERE id = ?').get(ticket.mailbox_id);
    await db
      .prepare(`UPDATE tickets SET mailbox_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(mailbox.id, ticket.id);
    await logEvent(
      ticket.id,
      'mailbox_reassigned',
      `Moved from ${previousMailbox ? previousMailbox.email : 'a different mailbox'} to ${mailbox.email} - they replied to it directly`
    );
    ticket.mailbox_id = mailbox.id;
  }

  if (!['unassigned', 'assigned'].includes(ticket.status)) return false;

  // Guard against misattributing an OUTBOUND message that's actually OLDER
  // than the ticket itself (e.g. the original message that started this
  // thread, sent before anyone had replied and before a ticket even existed
  // for it - see the module comment at the top of this file) as "the
  // reply". Without this check, first_replied_at could end up earlier than
  // first_received_at, producing a negative TAT that silently corrupts the
  // team-wide average on the Dashboard. Only Sent messages that actually
  // happened after the ticket's own first inbound message count as a real
  // reply.
  const sentAt = new Date(sentMessage.receivedAt || parseInt(sentMessage.internalDate || '0', 10));
  const firstReceivedAt =
    ticket.first_received_at instanceof Date ? ticket.first_received_at : new Date(ticket.first_received_at);
  if (
    !Number.isNaN(sentAt.getTime()) &&
    !Number.isNaN(firstReceivedAt.getTime()) &&
    sentAt.getTime() <= firstReceivedAt.getTime()
  ) {
    return false;
  }

  await db
    .prepare(
      `UPDATE tickets
       SET status = 'replied', last_reply_mode = 'external_detected',
           first_replied_at = COALESCE(first_replied_at, ?), updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(sentMessage.receivedAt || new Date().toISOString(), ticket.id);

  await db
    .prepare(`INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES (?, NULL, ?, ?)`)
    .run(
      ticket.id,
      'reply_detected_external',
      `Detected an outgoing reply in Sent (${sentMessage.providerMessageId}), not sent via this tool`
    );

  return true;
}

async function pollMailbox(mailbox) {
  const adapter = providerFor(mailbox);
  try {
    const messages = await adapter.listNewMessages(mailbox);
    let created = 0;
    let updated = 0;
    let maxInternalDate = mailbox.last_internal_date || '0';

    for (const message of messages) {
      const result = await createTicketFromMessage(mailbox, message);
      if (result.created) created += 1;
      else if (result.ticketId) updated += 1;
      if (message.internalDate && message.internalDate > maxInternalDate) {
        maxInternalDate = message.internalDate;
      }
    }

    let detectedReplies = 0;
    let maxSentInternalDate = mailbox.last_sent_internal_date || '0';
    if (adapter.listSentMessages) {
      const sentMessages = await adapter.listSentMessages(mailbox);
      for (const sentMessage of sentMessages) {
        if (await detectExternalReply(mailbox, sentMessage)) detectedReplies += 1;
        if (sentMessage.internalDate && sentMessage.internalDate > maxSentInternalDate) {
          maxSentInternalDate = sentMessage.internalDate;
        }
      }
    }

    await db
      .prepare(
        `UPDATE mailboxes SET last_internal_date = ?, last_sent_internal_date = ?, last_synced_at = datetime('now'), status = 'connected', updated_at = datetime('now') WHERE id = ?`
      )
      .run(maxInternalDate, maxSentInternalDate, mailbox.id);

    if (created > 0 || updated > 0 || detectedReplies > 0) {
      console.log(
        `[poller] ${mailbox.email}: created ${created} new ticket(s), updated ${updated} existing thread(s), detected ${detectedReplies} external repl(y/ies)`
      );
    }
  } catch (err) {
    console.error(`[poller] Failed to poll mailbox ${mailbox.email}:`, err.message);
    await db
      .prepare(`UPDATE mailboxes SET status = 'error', updated_at = datetime('now') WHERE id = ?`)
      .run(mailbox.id);
  }
}

async function pollAllMailboxes() {
  const mailboxes = await db.prepare(`SELECT * FROM mailboxes WHERE refresh_token IS NOT NULL`).all();
  for (const mailbox of mailboxes) {
    await pollMailbox(mailbox);
  }
}

let started = false;

function startPoller() {
  if (started) return;
  if (!config.enableInternalPoller) {
    console.log(
      '[poller] ENABLE_INTERNAL_POLLER is not "true" - skipping the in-process scheduler. ' +
        'On Vercel, POST /api/cron/poll (wired to a Vercel Cron Job) drives polling instead.'
    );
    return;
  }
  started = true;

  cron.schedule(config.pollCron, () => {
    pollAllMailboxes().catch((err) => console.error('[poller] Unexpected error:', err));
  });

  console.log(`[poller] Scheduled with cron expression "${config.pollCron}"`);

  // Kick off an initial poll shortly after boot so new tickets show up
  // quickly rather than waiting a full interval.
  setTimeout(() => {
    pollAllMailboxes().catch((err) => console.error('[poller] Initial poll failed:', err));
  }, 5000);
}

module.exports = {
  startPoller,
  pollAllMailboxes,
  pollMailbox,
  createTicketFromMessage,
  detectExternalReply,
  recordMessage,
};
