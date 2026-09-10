// Per-person drilldown: everything the person page needs in one call.
// GET /api/stats/person/:id?from_date=&to_date=&group=day|week|month&mailboxIds=
//
// Admin-only, same as /api/stats - it exposes one team member's numbers
// alongside the team average, which agents shouldn't see.
//
// Mailbox scoping comes from services/mailboxScope.js, so the person page
// honours the same filter button as the Dashboard: untick a mailbox there
// and this person's numbers exclude it too.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { fmtDuration } = require('../services/tat');
const { resolveMailboxScope } = require('../services/mailboxScope');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Hours after which an unanswered ticket is flagged red. Worth moving to
// app_settings later - an exam query at 72h is a crisis, a certificate
// request isn't, so different mailboxes reasonably want different numbers.
const OVERDUE_HOURS = 72;

const FIRST_RESPONSE_EXPR = `(
  CASE
    WHEN assigned_at IS NOT NULL AND first_replied_at IS NOT NULL
      THEN LEAST(assigned_at, first_replied_at)
    ELSE COALESCE(assigned_at, first_replied_at)
  END
)`;
const RESOLUTION_EXPR = `COALESCE(closed_at, first_replied_at)`;

const GROUPS = { day: 'day', week: 'week', month: 'month' };

router.get('/:id', async (req, res, next) => {
  try {
    const memberId = parseInt(req.params.id, 10);
    if (!Number.isInteger(memberId)) return res.status(400).json({ error: 'Bad member id' });

    const member = await db
      .prepare('SELECT id, name, email FROM team_members WHERE id = ?')
      .get(memberId);
    if (!member) return res.status(404).json({ error: 'No such team member' });

    const { from_date, to_date } = req.query;
    const group = GROUPS[req.query.group] || 'week';

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

    const scope = await resolveMailboxScope(req.user.id, req.query.mailboxIds);
    const mbSql = scope.sql;
    const mbParams = scope.params;

    // --- counts -----------------------------------------------------------
    // `who` is spliced in so the same query serves both this person and the
    // team-wide baseline; its params always come first because it sits ahead
    // of dateSql/mbSql in the string (db.js numbers ? left-to-right).
    async function countFor(who, whoParams, extra, extraParams) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM tickets
           WHERE is_automated = 0 ${who} ${dateSql} ${mbSql} ${extra}`
        )
        .get(...whoParams, ...dateParams, ...mbParams, ...extraParams);
      return row.c;
    }

    async function tatFor(milestoneExpr, who, whoParams) {
      const row = await db
        .prepare(
          `SELECT AVG(EXTRACT(EPOCH FROM (${milestoneExpr} - first_received_at))) AS avg_seconds,
                  COUNT(*) AS n
           FROM tickets
           WHERE is_automated = 0 AND ${milestoneExpr} IS NOT NULL AND first_received_at IS NOT NULL
             ${who} ${dateSql} ${mbSql}`
        )
        .get(...whoParams, ...dateParams, ...mbParams);
      const avg = row.avg_seconds == null ? null : Number(row.avg_seconds);
      return { avg_seconds: avg, avg_human: fmtDuration(avg), sample_size: row.n };
    }

    const MINE = 'AND assignee_id = ?';
    const ANYONE = 'AND assignee_id IS NOT NULL';

    const memberCount = await db
      .prepare('SELECT COUNT(*) AS c FROM team_members')
      .get();
    const headcount = Math.max(memberCount.c, 1);

    const openMine = await countFor(MINE, [memberId], "AND status IN ('assigned','unassigned')", []);
    const closedMine = await countFor(MINE, [memberId], "AND status = 'closed'", []);
    const openAll = await countFor(ANYONE, [], "AND status IN ('assigned','unassigned')", []);
    const closedAll = await countFor(ANYONE, [], "AND status = 'closed'", []);

    // Overdue = never answered, not closed, waiting past the threshold.
    // Deliberately measured on the wait rather than the ticket's age: a
    // ticket replied to on day one and sitting with the learner isn't late.
    const overdueWhere = `
      AND first_replied_at IS NULL
      AND status <> 'closed'
      AND first_received_at IS NOT NULL
      AND first_received_at < NOW() - INTERVAL '${OVERDUE_HOURS} hours'`;

    const overdueMine = await countFor(MINE, [memberId], overdueWhere, []);
    const overdueAll = await countFor(ANYONE, [], overdueWhere, []);

    const totals = {
      open: openMine,
      closed: closedMine,
      overdue: overdueMine,
      first_response: await tatFor(FIRST_RESPONSE_EXPR, MINE, [memberId]),
      resolution: await tatFor(RESOLUTION_EXPR, MINE, [memberId]),
    };

    const teamAvg = {
      open: Math.round(openAll / headcount),
      closed: Math.round(closedAll / headcount),
      overdue: Math.round(overdueAll / headcount),
      first_response: await tatFor(FIRST_RESPONSE_EXPR, ANYONE, []),
      resolution: await tatFor(RESOLUTION_EXPR, ANYONE, []),
    };

    // --- period breakdown -------------------------------------------------
    const periodRows = await db
      .prepare(
        `SELECT date_trunc('${group}', first_received_at)::date AS bucket,
                COUNT(*) AS received,
                SUM(CASE WHEN first_replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
                AVG(EXTRACT(EPOCH FROM (${FIRST_RESPONSE_EXPR} - first_received_at)))
                  FILTER (WHERE ${FIRST_RESPONSE_EXPR} IS NOT NULL) AS fr_avg_seconds,
                AVG(EXTRACT(EPOCH FROM (${RESOLUTION_EXPR} - first_received_at)))
                  FILTER (WHERE ${RESOLUTION_EXPR} IS NOT NULL) AS res_avg_seconds
         FROM tickets
         WHERE is_automated = 0 AND assignee_id = ? AND first_received_at IS NOT NULL
           ${dateSql} ${mbSql}
         GROUP BY 1 ORDER BY 1`
      )
      .all(memberId, ...dateParams, ...mbParams);

    const periods = periodRows.map((r) => ({
      bucket: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : r.bucket,
      received: r.received,
      replied: r.replied,
      closed: r.closed,
      first_response_avg_seconds: r.fr_avg_seconds == null ? null : Number(r.fr_avg_seconds),
      first_response_human: fmtDuration(r.fr_avg_seconds == null ? null : Number(r.fr_avg_seconds)),
      resolution_avg_seconds: r.res_avg_seconds == null ? null : Number(r.res_avg_seconds),
      resolution_human: fmtDuration(r.res_avg_seconds == null ? null : Number(r.res_avg_seconds)),
    }));

    // --- the actual overdue tickets --------------------------------------
    // Oldest wait first, not newest received - otherwise the worst ticket
    // ends up at the bottom of the list under things that arrived today.
    const overdueTickets = await db
      .prepare(
        `SELECT t.id, t.subject, t.status, t.first_received_at, m.email AS mailbox,
                EXTRACT(EPOCH FROM (NOW() - t.first_received_at)) / 3600 AS waiting_hours
         FROM tickets t
         JOIN mailboxes m ON m.id = t.mailbox_id
         WHERE t.is_automated = 0 AND t.assignee_id = ?
           ${overdueWhere.replace(/first_replied_at|status|first_received_at/g, (s) => `t.${s}`)}
           ${dateSql.replace(/first_received_at/g, 't.first_received_at')}
           ${mbSql.replace(/mailbox_id/, 't.mailbox_id')}
         ORDER BY t.first_received_at ASC
         LIMIT 50`
      )
      .all(memberId, ...dateParams, ...mbParams);

    res.json({
      member,
      group,
      overdue_hours: OVERDUE_HOURS,
      totals,
      team_avg: teamAvg,
      periods,
      overdue_tickets: overdueTickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        mailbox: t.mailbox,
        received_at: t.first_received_at,
        waiting_hours: Math.round(Number(t.waiting_hours)),
      })),
      mailbox_filter: { options: scope.options, included: scope.included, excluded: scope.excluded },
      from_date: from_date || null,
      to_date: to_date || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;