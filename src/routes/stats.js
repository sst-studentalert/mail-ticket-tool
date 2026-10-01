// Dashboard stats: per-assignee counts by status with an explicit ticket-type
// filter (all / non-automated / automated).
// Also computes TAT (turnaround time), measured from first_received_at (the
// ticket's original arrival - stable even if the thread later gets
// follow-up messages that bump received_at forward):
//   - "first response" TAT: first_received_at -> first actual outbound reply.
//   - "resolution" TAT: first_received_at -> closed_at, falling back to
//     first_replied_at if the ticket was replied but never explicitly
//     closed (measures full resolution time).
// TAT averages only include tickets where the relevant milestone has happened.
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
const { resolveMailboxScope } = require('../services/mailboxScope');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const STATUSES = ['unassigned', 'assigned', 'replied', 'closed'];

// "First response" = the first actual outbound reply. Assignment is NOT a
// response, so assigned_at must not be used for FRT.
const FIRST_RESPONSE_EXPR = `first_replied_at`;
// "Resolution" = closed_at if present, else first_replied_at.
const RESOLUTION_EXPR = `COALESCE(closed_at, first_replied_at)`;

// SLA = resolution within 72 wall-clock hours from first receipt.
// First response is NOT part of SLA.
const RESOLUTION_TARGET_H = 72;

function slaPassExpr() {
  return `
    (
      (COALESCE(closed_at, first_replied_at) IS NOT NULL
        AND EXTRACT(EPOCH FROM (COALESCE(closed_at, first_replied_at) - first_received_at)) <= ${RESOLUTION_TARGET_H * 3600})
      OR
      (COALESCE(closed_at, first_replied_at) IS NULL
        AND CURRENT_TIMESTAMP <= first_received_at + INTERVAL '${RESOLUTION_TARGET_H} hours')
    )`;
}


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

    // Which mailboxes this Dashboard covers: the viewer's mailbox_access
    // allow-list, intersected with whatever they've ticked in the filter bar
    // (?mailboxIds=). See services/mailboxScope.js.
    const scope = await resolveMailboxScope(req.user.id, req.query.mailboxIds);
    const mailboxSql = scope.sql;
    const mailboxParams = scope.params;

    // Private mailbox isolation. Super Admin sees everything; everyone else
    // sees shared mailboxes plus their own private mailbox only.
    const privateMailboxSql = req.user.is_super_admin
      ? ''
      : `AND mailbox_id IN (
           SELECT id FROM mailboxes
           WHERE COALESCE(is_private, 0) = 0
              OR private_owner_id = ?
         )`;
    const privateMailboxParams = req.user.is_super_admin ? [] : [req.user.id];

    async function slaFor(extraWhere, extraParams) {
      const passExpr = slaPassExpr();
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE ${passExpr}) AS met
           FROM tickets
           WHERE is_automated = 0 AND first_received_at IS NOT NULL
             ${dateSql} ${mailboxSql} ${privateMailboxSql} ${extraWhere}`
        )
        .get(...dateParams, ...mailboxParams, ...privateMailboxParams, ...extraParams);
      const total = Number(row.total || 0);
      const met = Number(row.met || 0);
      return {
        met,
        total,
        missed: total - met,
        percent: total ? Math.round((met / total) * 100) : null,
      };
    }
    
    // Ticket type filter: all (default), non-automated, or automated.
    const automatedFilter = String(req.query.automated || 'all').toLowerCase();
    const ticketTypeSql = automatedFilter === 'true'
      ? 'AND is_automated = 1'
      : automatedFilter === 'false'
        ? 'AND is_automated = 0'
        : '';

    // Computes { avg_seconds, avg_human, sample_size } for a TAT metric over
    // a given WHERE clause (params must match placeholders in extraWhere),
    // always baselined against first_received_at (stable across reopens)
    // and always scoped to the current date range + mailbox access. Two
    // TIMESTAMPTZ values subtracted give an INTERVAL in Postgres;
    // EXTRACT(EPOCH FROM ...) turns that into seconds (SQLite's equivalent
    // was (julianday(a) - julianday(b)) * 86400).
    async function tatFor(milestoneExpr, extraWhere, extraParams) {
      const row = await db
        .prepare(
          `SELECT AVG(EXTRACT(EPOCH FROM (${milestoneExpr} - first_received_at))) AS avg_seconds,
                  COUNT(*) AS n
           FROM tickets
           WHERE 1=1 AND ${milestoneExpr} IS NOT NULL AND first_received_at IS NOT NULL
             ${ticketTypeSql} ${dateSql} ${mailboxSql} ${privateMailboxSql} ${extraWhere}`
        )
        .get(...dateParams, ...mailboxParams, ...privateMailboxParams, ...extraParams);
      const avgSeconds = row.avg_seconds == null ? null : Number(row.avg_seconds);
      return {
        avg_seconds: avgSeconds,
        avg_human: fmtDuration(avgSeconds),
        sample_size: row.n,
      };
    }

    async function countFor(extraWhere, extraParams) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE 1=1 ${ticketTypeSql} ${dateSql} ${mailboxSql} ${privateMailboxSql} ${extraWhere}`)
        .get(...dateParams, ...mailboxParams, ...privateMailboxParams, ...extraParams);
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
      const sla = await slaFor('AND assignee_id = ?', [member.id]);

      perAssignee.push({ member, counts, tat: { first_response: firstResponseTat, resolution: resolutionTat }, sla });
    }

    // Include historical assignees that are no longer in team_members so the
    // dashboard can reconcile the full ticket population.
    const knownMemberIds = new Set(members.map((m) => Number(m.id)));
    const assigneeRows = await db
      .prepare(`SELECT DISTINCT assignee_id FROM tickets WHERE assignee_id IS NOT NULL ${ticketTypeSql} ${dateSql} ${mailboxSql}`)
      .all(...dateParams, ...mailboxParams);
    const formerAssigneeIds = assigneeRows
      .map((r) => Number(r.assignee_id))
      .filter((id) => Number.isInteger(id) && !knownMemberIds.has(id));

    if (formerAssigneeIds.length) {
      const placeholders = formerAssigneeIds.map(() => '?').join(',');
      const formerCounts = {};
      for (const status of STATUSES) {
        formerCounts[status] = await countFor(
          `AND assignee_id IN (${placeholders}) AND status = ?`,
          [...formerAssigneeIds, status]
        );
      }
      formerCounts.total = STATUSES.reduce((sum, s) => sum + formerCounts[s], 0);
      const formerFirstResponseTat = await tatFor(
        FIRST_RESPONSE_EXPR,
        `AND assignee_id IN (${placeholders})`,
        formerAssigneeIds
      );
      const formerResolutionTat = await tatFor(
        RESOLUTION_EXPR,
        `AND assignee_id IN (${placeholders})`,
        formerAssigneeIds
      );
      const formerSla = await slaFor(
        `AND assignee_id IN (${placeholders})`,
        formerAssigneeIds
      );
      perAssignee.push({
        member: { id: null, name: 'Former / unknown assignee', email: '' },
        counts: formerCounts,
        tat: { first_response: formerFirstResponseTat, resolution: formerResolutionTat },
        sla: formerSla,
        historical: true,
      });
    }

    const unassignedCounts = {};
    for (const status of STATUSES) {
      unassignedCounts[status] = await countFor('AND assignee_id IS NULL AND status = ?', [status]);
    }
    unassignedCounts.total = STATUSES.reduce((sum, s) => sum + unassignedCounts[s], 0);

    const automatedExcludedTotal = (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 1 ${dateSql} ${mailboxSql}`)
        .get(...dateParams, ...mailboxParams)
    ).c;

    const automatedTotal = (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 1 ${dateSql} ${mailboxSql}`)
        .get(...dateParams, ...mailboxParams)
    ).c;

    const nonAutomatedTotal = (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE is_automated = 0 ${dateSql} ${mailboxSql}`)
        .get(...dateParams, ...mailboxParams)
    ).c;

    const totalTickets = (
      await db
        .prepare(`SELECT COUNT(*) AS c FROM tickets WHERE 1=1 ${ticketTypeSql} ${dateSql} ${mailboxSql}`)
        .get(...dateParams, ...mailboxParams)
    ).c;

    // Mailbox list itself is also scoped - an admin restricted to certain
    // mailboxes shouldn't even see other mailboxes' rows (with a count of
    // 0) in this table, since that still reveals which mailboxes exist.
    const mailboxListSql = scope.listSql;
    const mailboxListParams = scope.listParams;
    const mailboxPrivateListSql = req.user.is_super_admin
      ? ''
      : `AND (COALESCE(m.is_private, 0) = 0 OR m.private_owner_id = ?)`;

    // Per-status breakdown alongside the total, so unassigned + assigned +
    // replied + closed always sums to c (both computed with the exact same
    // is_automated/date-range filters, so they can't drift apart).
    const perMailbox = await db
      .prepare(
        `SELECT m.email,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id ${ticketTypeSql.replace(/is_automated/g, 't.is_automated')} ${dateSql} ${privateMailboxSql.replace(/mailbox_id/g, 't.mailbox_id')}) AS c,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id ${ticketTypeSql.replace(/is_automated/g, 't.is_automated')} AND t.status = 'unassigned' ${dateSql} ${privateMailboxSql.replace(/mailbox_id/g, 't.mailbox_id')}) AS unassigned,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id ${ticketTypeSql.replace(/is_automated/g, 't.is_automated')} AND t.status = 'assigned' ${dateSql} ${privateMailboxSql.replace(/mailbox_id/g, 't.mailbox_id')}) AS assigned,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id ${ticketTypeSql.replace(/is_automated/g, 't.is_automated')} AND t.status = 'replied' ${dateSql} ${privateMailboxSql.replace(/mailbox_id/g, 't.mailbox_id')}) AS replied,
                (SELECT COUNT(*) FROM tickets t WHERE t.mailbox_id = m.id ${ticketTypeSql.replace(/is_automated/g, 't.is_automated')} AND t.status = 'closed' ${dateSql} ${privateMailboxSql.replace(/mailbox_id/g, 't.mailbox_id')}) AS closed
         FROM mailboxes m
         ${mailboxListSql}
         ${mailboxPrivateListSql}
         ORDER BY m.email`
      )
      .all(...dateParams, ...privateMailboxParams, ...dateParams, ...privateMailboxParams, ...dateParams, ...privateMailboxParams, ...dateParams, ...privateMailboxParams, ...dateParams, ...privateMailboxParams, ...mailboxListParams, ...privateMailboxParams);

    const overallTat = {
      first_response: await tatFor(FIRST_RESPONSE_EXPR, '', []),
      resolution: await tatFor(RESOLUTION_EXPR, '', []),
    };

    const overallSla = await slaFor('', []);

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
         WHERE 1=1
           ${ticketTypeSql}
           AND first_received_at IS NOT NULL
           AND first_received_at::date >= (${trendFrom ? '?::date' : "(CURRENT_DATE - INTERVAL '30 days')"})
           ${to_date ? 'AND first_received_at::date <= ?::date' : ''}
           ${mailboxSql}
         GROUP BY first_received_at::date
         ORDER BY first_received_at::date`
      )
      .all(...(trendFrom ? [trendFrom] : []), ...(to_date ? [to_date] : []), ...mailboxParams, ...privateMailboxParams);

    const tatTrend = trendRows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
      first_response_avg_seconds: r.fr_avg_seconds == null ? null : Number(r.fr_avg_seconds),
      resolution_avg_seconds: r.res_avg_seconds == null ? null : Number(r.res_avg_seconds),
    }));

    res.json({
      per_assignee: perAssignee,
      unassigned: unassignedCounts,
      automated_excluded_total: automatedExcludedTotal,
      automated_total: automatedTotal,
      non_automated_total: nonAutomatedTotal,
      automated_filter: automatedFilter,
      total_tickets: totalTickets,
      per_mailbox: perMailbox,
      tat: overallTat,
      sla: overallSla,
      tat_trend: tatTrend,
      mailbox_filter: { options: scope.options, included: scope.included, excluded: scope.excluded },

      from_date: from_date || null,
      to_date: to_date || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
