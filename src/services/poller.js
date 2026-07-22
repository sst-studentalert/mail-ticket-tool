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

// Returns { ticketId, created } - created=true if a new ticket row was
// inserted, false if an existing thread's ticket was updated in place.
async function createTicketFromMessage(mailbox, message) {
  const existingByMessage = await db
    .prepare('SELECT id FROM tickets WHERE gmail_message_id = ?')
    .get(message.providerMessageId);
  if (existingByMessage) return { ticketId: null, created: false }; // already ticketed, skip

  const { isAutomated, reasons } = scoreMessage(message);

  // Is this a follow-up in a thread we've already ticketed (from this same
  // mailbox)? If so, update that ticket in place rather than creating a
  // second, disconnected ticket for the same conversation.
  const existingThreadTicket = await db
    .prepare('SELECT * FROM tickets WHERE mailbox_id = ? AND gmail_thread_id = ?')
    .get(mailbox.id, message.providerThreadId);

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
      mailbox.id,
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

  return { ticketId: info.lastInsertRowid, created: true };
}

// Checks the mailbox's Sent folder for outgoing messages and, for any whose
// thread matches an open ticket (still unassigned/assigned - i.e. nobody's
// marked it handled yet), auto-marks that ticket replied. This is how a
// reply sent directly from Gmail (bypassing this tool) still gets picked up,
// instead of relying on someone remembering to click "Mark replied
// externally". If the reply was actually sent *through* this tool, the
// ticket's status is already 'replied' by the time this runs, so it's
// naturally a no-op for those (no double-processing).
async function detectExternalReply(mailbox, sentMessage) {
  const ticket = await db
    .prepare(
      `SELECT * FROM tickets WHERE mailbox_id = ? AND gmail_thread_id = ? AND status IN ('unassigned', 'assigned')`
    )
    .get(mailbox.id, sentMessage.providerThreadId);
  if (!ticket) return false;

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

module.exports = { startPoller, pollAllMailboxes, pollMailbox, createTicketFromMessage, detectExternalReply };
