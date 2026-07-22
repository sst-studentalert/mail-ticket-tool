// One-off maintenance script: wipes all tickets (and their event history),
// leaving mailboxes/roster/logins untouched. Useful right after fixing a bad
// first-sync backfill, or any time you want a clean slate for tickets.
//
//   node scripts/clear-tickets.js
//
// Needs the same DATABASE_URL env var the server uses (loaded via dotenv in
// src/config.js), so run this with your .env in place / sourced.
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));

async function main() {
  await db.migrate();
  const before = (await db.prepare('SELECT COUNT(*) AS c FROM tickets').get()).c;
  await db.exec('DELETE FROM ticket_events; DELETE FROM tickets;');
  const after = (await db.prepare('SELECT COUNT(*) AS c FROM tickets').get()).c;
  console.log(`Cleared tickets: ${before} -> ${after}`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to clear tickets:', err);
  process.exit(1);
});
