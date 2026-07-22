// Dashboard stats: per-assignee counts by status, EXCLUDING automated
// tickets (is_automated = 1), plus a total automated-excluded count for
// transparency so the team can see how much volume is being filtered out.
// Also computes TAT (turnaround time), measured from first_received_at (the
// ticket's original arrival - stable even if the thread later gets
// follow-up messages that bump received_at forward):
//   - "first response" TAT: first_received_at -> first assignment or first
//     reply, whichever happened first (measures responsiveness).
//   - "resolution" TAT: first_received_at -> closed_at, falling back to
//     first_replied_at if the ticket was replied but never explicitly
//     closed (measures full resolution time).
// Both exclude automated tickets and only average over tickets where the
// relevant milestone has actually happened (so an all-unassigned inbox
// doesn't show a misleading TAT of zero).
// Supports optional ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD, filtering
// every count/TAT figure below to tickets whose first_received_at falls in
// that range - so the whole dashboard updates to that window.
// Admin-only: agents only ever see their own tickets in the Tickets tab, so
// team-wide stats aren't exposed to them here.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { fmtDuration } = require('../services/tat');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const STATUSES = ['unassigned', 'assigned', 'replied', 'closed'];

// "First response" = earliest of assigned_at / first_replied_at. Postgres
// has no scalar multi-arg MIN() like SQLite does - LEAST() is the
// Postgres equivalent for "smaller of these two values" (as opposed to
// MIN(), which in Postgres is only an aggregate over rows).
const FIRST_RESPONSE_EXPR = `(
  CASE
    WHEN assigned_at IS NOT NULL AND first_replied_at IS NOT NULL
      THEN LEAST(assigned_at, first_replied_at)
    ELSE COALESCE(assigned_at, first_replied_at)
  END
)`;
// "Resolution" = closed_at if present, else first_replied_at.
const RESOLUTION_EXPR = `COALESCE(closed_at, first_replied_at)`;

router.get('/', async (req, res, next) => {
  try {
    const { from_date, to_date } = req.query;

    // Shared date-range clause + params, appended to every query below.
    // Postgres has no date() function like SQLite - cast with ::date.
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

    // Computes { avg_seconds, avg_human, sample_size } for a TAT metric over
    // a given WHERE clause (params must match placeholders in extraWhere),
    // always baselined against first_received_at (stable across reopens)
    // and always scoped to the current date range. Two TIMESTAMPTZ values
    // subtracted give an INTERVAL in Postgres; EXTRACT(EPOCH FROM ...)
    // turns that into seconds (SQLite's equivalent was
    // (julianday(a) - julianday(b)) * 86400).
    async function tatFor(milestoneExpr, extraWhere, extraParams) {
      const row = await db
        .prepare(
          `SELECT AVG(EXTRACT(EPOCH FROM (${milestoneExpr} - first_received_at))) AS avg_seconds,
                  COUNT(*) AS n
           FROM tickets
           WHERE is_automated = 0 AND ${milestoneExpr} IS NOT NULL AND first_received_at IS NOT NULL
             ${dateSql} ${extraWhere}`
        )
        .get(...dateParams, ...extraParams);
      const avgSeconds = row.avg_seconds == null ? null : Number(row.avg_seconds);
      return {
        avg_seconds: avgSeconds,
        avg_human: fmtDuration(avgSeconds),
        sample_size: row.n,
      };
    }

    async function countFor(extraWhere, extraParams) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 0 ${dateSql} ${extraWhere}`)
        .get(...dateParams, ...extraParams);
      return row.c;
    }

    const members = await db.prepare('SELECT id, name, email FROM team_members ORDER BY name').all();

    const perAssignee = [];
    for (const member of members) {
      const counts = {};
      for (const status of STATUSES) {
        counts[status] = await countFor('AND assignee_id = ? AND status = ?', [member.id, status]);
      }
      counts.total = STATUSES.reduce((sum, s) => sum + counts[s], 0);

      const firstResponseTat = await tatFor(FIRST_RESPONSE_EXPR, 'AND assignee_id = ?', [member.id]);
      const resolutionTat = await tatFor(RESOLUTION_EXPR, 'AND assignee_id = ?', [member.id]);

      perAssignee.push({ member, counts, tat: { first_response: firstResponseTat, resolution: resolutionTat } });
    }

    const unassignedCounts = {};
    for (const status of STATUSES) {
      unassignedCounts[status] = await countFor('AND assignee_id IS NULL AND status = ?', [status]);
    }
    unassignedCounts.total = STATUSES.reduce((sum, s) => sum + unassignedCounts[s], 0);

    const automatedExcludedTotal = (
      await db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 1 ${dateSql}`).get(...dateParams)
    ).c;

    const totalTickets = (
      await db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE 1=1 ${dateSql}`).get(...dateParams)
    ).c;

    const perMailbox = await db
      .prepare(
        `SELECT m.email,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id AND t.is_automated = 0 ${dateSql}) AS c
         FROM mailboxes m
         ORDER BY m.email`
      )
      .all(...dateParams);

    const overallTat = {
      first_response: await tatFor(FIRST_RESPONSE_EXPR, '', []),
      resolution: await tatFor(RESOLUTION_EXPR, '', []),
    };

    // Daily TAT trend, for the Dashboard's "TAT over time" chart - one row
    // per calendar day (by first_received_at) with that day's average
    // first-response/resolution TAT (in seconds; the frontend converts to
    // hours for the chart). Defaults to the last 30 days if no date range
    // is set, so the chart isn't unbounded on a long-running install.
    const trendFrom = from_date || null;
    const trendRows = await db
      .prepare(
        `SELECT
           first_received_at::date AS day,
           AVG(EXTRACT(EPOCH FROM (${FIRST_RESPONSE_EXPR} - first_received_at)))
             FILTER (WHERE ${FIRST_RESPONSE_EXPR} IS NOT NULL) AS fr_avg_seconds,
           AVG(EXTRACT(EPOCH FROM (${RESOLUTION_EXPR} - first_received_at)))
             FILTER (WHERE ${RESOLUTION_EXPR} IS NOT NULL) AS res_avg_seconds
         FROM tickets
         WHERE is_automated = 0
           AND first_received_at IS NOT NULL
           AND first_received_at::date >= (${trendFrom ? '?::date' : "(CURRENT_DATE - INTERVAL '30 days')"})
           ${to_date ? 'AND first_received_at::date <= ?::date' : ''}
         GROUP BY first_received_at::date
         ORDER BY first_received_at::date`
      )
      .all(...(trendFrom ? [trendFrom] : []), ...(to_date ? [to_date] : []));

    const tatTrend = trendRows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
      first_response_avg_seconds: r.fr_avg_seconds == null ? null : Number(r.fr_avg_seconds),
      resolution_avg_seconds: r.res_avg_seconds == null ? null : Number(r.res_avg_seconds),
    }));

    res.json({
      per_assignee: perAssignee,
      unassigned: unassignedCounts,
      automated_excluded_total: automatedExcludedTotal,
      total_tickets: totalTickets,
      per_mailbox: perMailbox,
      tat: overallTat,
      tat_trend: tatTrend,
      from_date: from_date || null,
      to_date: to_date || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
