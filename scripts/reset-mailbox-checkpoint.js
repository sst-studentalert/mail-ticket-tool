// One-off maintenance script: rolls a mailbox's poller "checkpoint" columns
// (last_internal_date / last_sent_internal_date) back to a given point in
// time, forcing the NEXT poll to re-scan everything after that point again -
// including messages Gmail already returned once but which got excluded for
// being "not newer than checkpoint".
//
// Why you'd need this: the checkpoint only ever moves forward. If a message
// arrived while a mailbox's OAuth connection was broken (invalid_grant) and
// the checkpoint happened to advance past its timestamp anyway (e.g. from a
// partially-successful poll, or from another message landing after it before
// the connection died), that message is stranded forever - the poller will
// never look at it again on its own.
//
// This is safe to re-run / safe even if some of the re-scanned messages were
// already processed correctly the first time:
//   - Inbound messages: ticket_messages + tickets are keyed/deduped by Gmail's
//     own message id (gmail_message_id), so re-seeing an old inbox message
//     just no-ops.
//   - Sent messages (external-reply detection): detectExternalReply only
//     acts on tickets still in status unassigned/assigned - a ticket already
//     correctly marked "replied" from the first pass won't match again.
//
//   node scripts/reset-mailbox-checkpoint.js <mailbox-email> <ISO-date>
//
// Example:
//   node scripts/reset-mailbox-checkpoint.js studentalert@sst.scaler.com 2026-07-27T00:00:00Z
//
// Needs the same DATABASE_URL env var the server uses (loaded via dotenv in
// src/config.js), so run this with your .env in place / sourced.
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));

async function main() {
  const [email, isoDate] = process.argv.slice(2);
  if (!email || !isoDate) {
    console.error('Usage: node scripts/reset-mailbox-checkpoint.js <mailbox-email> <ISO-date>');
    process.exit(1);
  }

  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    console.error(`Could not parse date: ${isoDate}`);
    process.exit(1);
  }
  const ms = String(date.getTime());

  await db.migrate();

  const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE email = ?').get(email);
  if (!mailbox) {
    console.error(`No mailbox found with email ${email}`);
    process.exit(1);
  }

  console.log(`Mailbox ${email} (id ${mailbox.id}):`);
  console.log(`  last_internal_date:      ${mailbox.last_internal_date} -> ${ms}`);
  console.log(`  last_sent_internal_date: ${mailbox.last_sent_internal_date} -> ${ms}`);

  await db
    .prepare(
      `UPDATE mailboxes
       SET last_internal_date = ?, last_sent_internal_date = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(ms, ms, mailbox.id);

  console.log(`Done. Checkpoint reset to ${date.toISOString()} (${ms} ms). Trigger a poll to re-scan from there.`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to reset mailbox checkpoint:', err);
  process.exit(1);
});
