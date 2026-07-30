// One-off maintenance script: repairs tickets corrupted by a since-fixed bug
// in the Sent-folder "detect external reply" scan (see the guard added to
// detectExternalReply in src/services/poller.js). That bug could mark a
// ticket "replied" using an OUTBOUND message that actually happened BEFORE
// the ticket's own first inbound message - e.g. a mailbox proactively
// emailing someone first, with no ticket created for it (poller only
// ticket-creates from inbox mail), and only later, once the recipient
// replies, does a ticket get created - dated to that reply. The old code
// would then find the ORIGINAL outbound message sitting in Sent, see the
// new ticket was open, and wrongly treat that older message as "the reply",
// setting first_replied_at to a timestamp earlier than first_received_at.
// That produces a negative "time to reply", which the UI's duration
// formatter clamps to display as "<1m" - looking like an implausibly fast
// reply instead of the broken data it actually is.
//
// This script finds any ticket in that exact corrupted shape (marked
// replied via external detection, with first_replied_at <= first_received_at)
// and resets it: status back to assigned/unassigned (based on whether it
// has an assignee), first_replied_at and last_reply_mode cleared, and logs a
// ticket_event noting the correction - so it shows up as needing genuine
// attention again, and no longer drags a bogus fast/negative number into
// team-wide TAT averages.
//
// Safe to re-run - a ticket that's already been fixed (or was never
// affected) won't match the WHERE clause a second time.
//
//   node scripts/fix-corrupted-replies.js
//
// Needs the same DATABASE_URL env var the server uses (loaded via dotenv in
// src/config.js), so run this with your .env in place / sourced.
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));

async function main() {
  await db.migrate();

  const affected = await db
    .prepare(
      `SELECT * FROM tickets
       WHERE last_reply_mode = 'external_detected'
         AND status = 'replied'
         AND first_replied_at IS NOT NULL
         AND first_received_at IS NOT NULL
         AND first_replied_at <= first_received_at`
    )
    .all();

  console.log(`Found ${affected.length} ticket(s) corrupted by the Sent-scan ordering bug.`);

  for (const ticket of affected) {
    const newStatus = ticket.assignee_id ? 'assigned' : 'unassigned';

    await db
      .prepare(
        `UPDATE tickets
         SET status = ?, first_replied_at = NULL, last_reply_mode = NULL, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(newStatus, ticket.id);

    await db
      .prepare(`INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES (?, NULL, ?, ?)`)
      .run(
        ticket.id,
        'correction',
        `Reset by fix-corrupted-replies.js: had been incorrectly marked replied using an outbound message (${ticket.first_replied_at}) that predates this ticket's first received message (${ticket.first_received_at})`
      );

    console.log(`  Fixed ticket #${ticket.id} ("${ticket.subject || '(no subject)'}") -> status: ${newStatus}`);
  }

  console.log('Done.');
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to fix corrupted replies:', err);
  process.exit(1);
});
