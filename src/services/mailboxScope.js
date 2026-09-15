// Resolves which mailboxes an aggregate view should cover, folding TWO
// separate things into the single mailboxSql/mailboxParams pair that
// routes/stats.js and routes/myStats.js already thread through every query:
//
//   1. ACCESS - the mailbox_access allow-list, via
//      services/mailboxAccess.js. Not a preference. Never widened by
//      anything the client sends.
//   2. SELECTION - which mailboxes the viewer has ticked in the Dashboard
//      filter bar, sent as ?mailboxIds=1,3,4. A preference. Absent means
//      "use the admin-configured default".
//
// The selection is always INTERSECTED with the access set, never unioned.
// Without that, an agent restricted to one mailbox could hand-edit
// ?mailboxIds= in the URL and pull team-wide aggregates - turning a
// convenience filter into exactly the leak mailbox_access exists to
// prevent.
//
// Requires the in_scope column:
//   ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS in_scope INTEGER NOT NULL DEFAULT 1;
// added alongside the other ADD COLUMN IF NOT EXISTS statements in db.js.
// in_scope = 0 means "not ticked by default" (e.g. the dean mailbox), NOT
// "hidden" - a viewer can still tick it back on for a one-off look.
const db = require('../db');
const { getAccessibleMailboxIds } = require('./mailboxAccess');

// null  => param absent entirely, caller wants the default selection
// []    => param present but empty, caller has unticked everything
//
// The empty-string case MUST return [] and not null. The Dashboard sends
// `?mailboxIds=` when every box is unticked, and treating that as "absent"
// would quietly reset to the default selection instead of showing zeros -
// i.e. unticking everything would appear to do nothing.
function parseRequested(raw) {
  if (raw === undefined || raw === null) return null;
  if (raw === '') return [];
  return String(raw)
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
}

/**
 * @param {number} userId       req.user.id
 * @param {string} rawParam     req.query.mailboxIds
 * @returns {Promise<{
 *   ids: number[],
 *   sql: string, params: any[],
 *   listSql: string, listParams: any[],
 *   options: {id:number,email:string,in_scope:number,selected:boolean}[],
 *   included: string[], excluded: string[]
 * }>}
 *
 * `sql` slots straight into the existing `${mailboxSql}` holes (it uses a
 * bare `mailbox_id`, so myStats.js's existing
 * `.replace(/mailbox_id/, 't.mailbox_id')` keeps working unchanged).
 * `listSql` replaces stats.js's inline mailboxListSql for the per-mailbox
 * table, so an unticked mailbox drops out of that table too rather than
 * lingering with a count of 0.
 */
async function resolveMailboxScope(userId, rawParam) {
  const all = await db.prepare('SELECT id, email, in_scope FROM mailboxes ORDER BY email').all();

  // null here means unrestricted (see services/mailboxAccess.js).
  const accessible = await getAccessibleMailboxIds(userId);
  const allowedIds = accessible === null ? all.map((m) => m.id) : accessible;
  const allowedSet = new Set(allowedIds);
  const visible = all.filter((m) => allowedSet.has(m.id));

  const requested = parseRequested(rawParam);

  let ids;
  if (requested === null) {
    // No explicit selection: default to everything the viewer may see that
    // an admin hasn't marked out of scope.
    const defaults = visible.filter((m) => Number(m.in_scope) === 1).map((m) => m.id);
    // If somebody has marked every mailbox out of scope, fall back to all of
    // them rather than serving an all-zero Dashboard, which reads as a bug.
    ids = defaults.length ? defaults : allowedIds;
  } else {
    ids = requested.filter((id) => allowedSet.has(id));
  }

  const selected = new Set(ids);
  const included = visible.filter((m) => selected.has(m.id)).map((m) => m.email);
  const excluded = visible.filter((m) => !selected.has(m.id)).map((m) => m.email);

  const options = visible.map((m) => ({
    id: m.id,
    email: m.email,
    in_scope: Number(m.in_scope),
    selected: selected.has(m.id),
  }));

  let sql = '';
  let params = [];
  let listSql = '';
  let listParams = [];

  if (accessible === null && excluded.length === 0) {
    // Unrestricted viewer with nothing filtered out: emit no clause at all,
    // so behaviour is byte-identical to before this feature existed.
  } else if (ids.length === 0) {
    // Everything unticked must yield zeros. An empty clause here would
    // silently mean "no filter" and show every mailbox - the exact opposite.
    sql = 'AND 1 = 0';
    listSql = 'WHERE 1 = 0';
  } else {
    sql = 'AND mailbox_id = ANY(?)';
    params = [ids];
    listSql = 'WHERE m.id = ANY(?)';
    listParams = [ids];
  }

  return { ids, sql, params, listSql, listParams, options, included, excluded };
}

module.exports = { resolveMailboxScope };