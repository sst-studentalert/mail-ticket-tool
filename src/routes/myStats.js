// Personal stats: "how am I doing" for whoever is logged in, scoped to
// tickets assigned to THEM specifically. Unlike /api/stats (admin-only,
// team-wide), this is open to everyone - agents get a view of their own
// queue/mailbox breakdown/TAT that they otherwise can't see (they only see
// their own tickets in the Tickets tab, with no summary), and admins get a
// "my tickets" view of their own since the team Dashboard only shows
// aggregate/per-person team numbers, not "my own work" specifically.
// Supports the same ?from_date=&to_date= range as /api/stats.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { fmtDuration } = require('../services/tat');
const { getAccessibleMailboxIds } = require('../services/mailboxAccess');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['unassigned', 'assigned', 'replied', 'closed'];

const FIRST_RESPONSE_EXPR = `(
  CASE
    WHEN assigned_at IS NOT NULL AND first_replied_at IS NOT NULL
      THEN LEAST(assigned_at, first_replied_at)
    ELSE COALESCE(assigned_at, first_replied_at)
  END
)`;
const RESOLUTION_EXPR = `COALESCE(closed_at, first_replied_at)`;

router.get('/', async (req, res, next) => {
  try {
    const { from_date, to_date } = req.query;
    const userId = req.user.id;

    const dateClauses = [];
    const dateParams = [];
    if (from_date) {
      dateClauses.push('first_received_at::date >= ?::date');
      dateParams.push(from_date);
    }
    if (to_date) {
      dateClauses.push('first_received_at::date <= ?::date');
      dateParams.push(to_date);
    }
    const dateSql = dateClauses.length ? `AND ${dateClauses.join(' AND ')}` : '';

    // Mailbox access allow-list (see services/mailboxAccess.js). In
    // practice a ticket can't get assigned to someone outside their granted
    // mailboxes any more (see routes/tickets.js's /assign guard), but this
    // is kept as a defensive second layer in case access is revoked after
    // the fact - so "my tickets" never shows something from a mailbox this
    // person no longer has access to.
    const accessibleMailboxIds = await getAccessibleMailboxIds(userId);
    let mailboxSql = '';
    let mailboxParams = [];
    if (accessibleMailboxIds !== null) {
      if (accessibleMailboxIds.length === 0) {
        mailboxSql = 'AND 1 = 0';
      } else {
        mailboxSql = 'AND mailbox_id = ANY(?)';
        mailboxParams = [accessibleMailboxIds];
      }
    }

    async function tatFor(milestoneExpr) {
      const row = await db
        .prepare(
          `SELECT AVG(EXTRACT(EPOCH FROM (${milestoneExpr} - first_received_at))) AS avg_seconds,
                  COUNT(*) AS n
           FROM tickets
           WHERE is_automated = 0 AND assignee_id = ? AND ${milestoneExpr} IS NOT NULL AND first_received_at IS NOT NULL
             ${dateSql} ${mailboxSql}`
        )
        .get(userId, ...dateParams, ...mailboxParams);
      const avgSeconds = row.avg_seconds == null ? null : Number(row.avg_seconds);
      return { avg_seconds: avgSeconds, avg_human: fmtDuration(avgSeconds), sample_size: row.n };
    }

    const counts = {};
    for (const status of STATUSES) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 0 AND assignee_id = ? AND status = ? ${dateSql} ${mailboxSql}`
        )
        .get(userId, status, ...dateParams, ...mailboxParams);
      counts[status] = row.c;
    }
    counts.total = STATUSES.reduce((sum, s) => sum + counts[s], 0);
    // "Unresolved" = mine, not yet replied or closed (i.e. still needs action).
    counts.unresolved = counts.assigned; // 'unassigned' never applies to "my" tickets by definition

    const perMailbox = await db
      .prepare(
        `SELECT m.email,
                COUNT(*) AS total,
                SUM(CASE WHEN t.status IN ('assigned') THEN 1 ELSE 0 END) AS unresolved,
                SUM(CASE WHEN t.status = 'replied' THEN 1 ELSE 0 END) AS replied,
                SUM(CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END) AS closed
         FROM tickets t
         JOIN mailboxes m ON m.id = t.mailbox_id
         WHERE t.is_automated = 0 AND t.assignee_id = ? ${dateSql} ${mailboxSql.replace(/mailbox_id/, 't.mailbox_id')}
         GROUP BY m.id
         ORDER BY m.email`
      )
      .all(userId, ...dateParams, ...mailboxParams);

    const tat = {
      first_response: await tatFor(FIRST_RESPONSE_EXPR),
      resolution: await tatFor(RESOLUTION_EXPR),
    };

    // So a confusing "0 tickets" isn't silent when the reason is that your
    // only assigned ticket(s) happen to be flagged automated (which are
    // excluded from every count above, same as the team Dashboard).
    const automatedExcludedTotal = (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 1 AND assignee_id = ? ${dateSql} ${mailboxSql}`)
        .get(userId, ...dateParams, ...mailboxParams)
    ).c;

    res.json({
      counts,
      per_mailbox: perMailbox,
      tat,
      automated_excluded_total: automatedExcludedTotal,
      from_date: from_date || null,
      to_date: to_date || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
