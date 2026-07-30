// Per-person mailbox access allow-list (see the mailbox_access table
// comment in db.js for the full rationale). Shared by tickets.js, stats.js,
// and myStats.js so ticket-level visibility and aggregate KPI numbers stay
// consistent with each other.
const db = require('../db');

// Returns null if the member is unrestricted (sees every mailbox - the
// default for anyone who's never had specific mailboxes granted), or an
// array of mailbox ids they're allowed to see otherwise.
async function getAccessibleMailboxIds(memberId) {
  const rows = await db
    .prepare('SELECT mailbox_id FROM mailbox_access WHERE team_member_id = ?')
    .all(memberId);
  if (rows.length === 0) return null;
  return rows.map((r) => r.mailbox_id);
}

// Convenience check for a single ticket/mailbox against a set of accessible
// ids (as returned by getAccessibleMailboxIds) - null always passes (means
// unrestricted).
function mailboxAllowed(accessibleMailboxIds, mailboxId) {
  if (accessibleMailboxIds === null) return true;
  return accessibleMailboxIds.includes(mailboxId);
}

module.exports = { getAccessibleMailboxIds, mailboxAllowed };
