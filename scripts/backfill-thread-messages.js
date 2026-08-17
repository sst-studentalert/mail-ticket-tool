// One-off maintenance script: backfills ticket_messages with each ticket's
// FULL Gmail thread history, straight from Gmail - not from the incremental
// checkpoint-based poller scans.
//
// Why this is needed: two separate gaps meant some real messages were never
// recorded into ticket_messages, even though they exist in Gmail and (for
// the ticket's own thread) are visible in the Gmail UI:
//   1. A mailbox's own PROACTIVE first message (sent before anyone replied,
//      before a ticket even existed for that thread) - the poller only ever
//      creates a ticket from an INBOUND message, and by the time the ticket
//      exists, that original outbound message's timestamp has usually
//      already fallen behind the mailbox's Sent-folder checkpoint, so it's
//      never fetched again.
//   2. Any outbound message sent in a thread AFTER the ticket's status had
//      already moved past unassigned/assigned (e.g. a staff member
//      forwarding the thread to a colleague once it's already "replied") -
//      detectExternalReply used to gate its Sent-folder scan on the ticket
//      still being unassigned/assigned, so later messages were silently
//      skipped. Fixed going forward in poller.js, but doesn't retroactively
//      fill in what was already missed.
//
// This script re-fetches each ticket's Gmail thread in full (one
// threads.get call per ticket) and inserts any message not already present
// in ticket_messages (dedup via the existing gmail_message_id unique index,
// so this is safe to re-run and can't create duplicates).
//
//   node scripts/backfill-thread-messages.js
//
// Needs the same DATABASE_URL env var the server uses (loaded via dotenv in
// src/config.js), so run this with your .env in place / sourced.
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const gmailAdapter = require(path.join(__dirname, '..', 'src', 'services', 'gmailAdapter'));
const { recordMessage } = require(path.join(__dirname, '..', 'src', 'services', 'poller'));

async function main() {
  await db.migrate();

  const tickets = await db
    .prepare(
      `SELECT t.*, m.email AS mailbox_email
       FROM tickets t
       JOIN mailboxes m ON m.id = t.mailbox_id
       WHERE m.refresh_token IS NOT NULL
       ORDER BY t.id`
    )
    .all();

  console.log(`Checking ${tickets.length} ticket(s) with a connected mailbox...`);

  let ticketsWithNewMessages = 0;
  let totalInserted = 0;
  let failures = 0;
  const mailboxCache = new Map();

  for (const ticket of tickets) {
    try {
      if (!mailboxCache.has(ticket.mailbox_id)) {
        mailboxCache.set(
          ticket.mailbox_id,
          await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ticket.mailbox_id)
        );
      }
      const mailboxRow = mailboxCache.get(ticket.mailbox_id);
      const threadMessages = await gmailAdapter.getThreadMessages(mailboxRow, ticket.gmail_thread_id);
      let insertedForTicket = 0;
      for (const msg of threadMessages) {
        const { inserted } = await recordMessage(ticket.id, {
          gmailMessageId: msg.providerMessageId,
          direction: msg.direction,
          fromAddress: msg.from,
          toAddress: msg.headers && msg.headers.to,
          ccAddress: msg.headers && msg.headers.cc,
          body: msg.bodyText,
          bodyHtml: msg.bodyHtml,
          sentAt: msg.receivedAt,
        });
        if (inserted) insertedForTicket += 1;
      }
      if (insertedForTicket > 0) {
        ticketsWithNewMessages += 1;
        totalInserted += insertedForTicket;
        console.log(
          `  Ticket #${ticket.id} ("${ticket.subject || '(no subject)'}", ${ticket.mailbox_email}): +${insertedForTicket} message(s)`
        );
      }
    } catch (err) {
      failures += 1;
      console.error(`  Ticket #${ticket.id}: failed to backfill - ${err.message}`);
    }
  }

  console.log(
    `Done. ${ticketsWithNewMessages} ticket(s) gained messages, ${totalInserted} message(s) inserted total, ${failures} failure(s).`
  );
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to backfill thread messages:', err);
  process.exit(1);
});
