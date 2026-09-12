const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const gmailAdapter = require('../services/gmailAdapter');
const { computeTicketTat } = require('../services/tat');
const { getAccessibleMailboxIds, getFullAccessMailboxIds, mailboxAllowed } = require('../services/mailboxAccess');
const { recordMessage } = require('../services/poller');

const router = express.Router();
router.use(requireAuth);

const PROVIDERS = { gmail: gmailAdapter };


const FIRST_REPLY_TARGET_H = 24;
const RESOLUTION_TARGET_H = 72;


// ---------------------------------------------------------------------------
// Live learner mapping from Google Sheets
// ---------------------------------------------------------------------------
// The backend reads the "Consolidated" tab directly from the online Google
// Sheet. The sheet must be shared so that the deployed backend can read it
// without a Google login.
//
// Google Sheet:
// https://docs.google.com/spreadsheets/d/19mFOOpN1wqDoWMazVeQ5ni28mU2i9cICUvBPrzE7kRM/edit?gid=0
//
// Set LEARNER_SHEET_ID / LEARNER_SHEET_GID in Vercel if you ever move the
// source sheet. Defaults below are the current sheet.
const LEARNER_SHEET_ID =
  process.env.LEARNER_SHEET_ID || '19mFOOpN1wqDoWMazVeQ5ni28mU2i9cICUvBPrzE7kRM';
const LEARNER_SHEET_GID = process.env.LEARNER_SHEET_GID || '0';
const LEARNER_SHEET_CACHE_MS = 5 * 60 * 1000;

let learnerSheetCache = {
  loadedAt: 0,
  mapping: {},
};

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells.map((v) => v.trim());
}

function parseGoogleSheetCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

  if (!lines.length) return {};

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const nameIndex = headers.findIndex((h) => h === 'name');
  const emailIndex = headers.findIndex((h) => h === 'sst email');

  if (nameIndex < 0 || emailIndex < 0) {
    throw new Error(
      `Google Sheet must contain columns "Name" and "SST Email". Found: ${headers.join(', ')}`
    );
  }

  const mapping = {};

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[nameIndex] || '').trim();
    const email = normalizeLearnerEmail(cells[emailIndex] || '');

    if (!email) continue;

    // First row wins if the same email appears more than once.
    if (!mapping[email]) {
      mapping[email] = {
        name: name || email,
      };
    }
  }

  return mapping;
}

async function loadLearnerMapping() {
  const now = Date.now();

  if (
    learnerSheetCache.loadedAt &&
    now - learnerSheetCache.loadedAt < LEARNER_SHEET_CACHE_MS
  ) {
    return learnerSheetCache.mapping;
  }

  const url =
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(LEARNER_SHEET_ID)}` +
    `/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(LEARNER_SHEET_GID)}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google Sheet returned HTTP ${response.status}`);
    }

    const text = await response.text();

    // A private Google Sheet usually returns a Google login/error page
    // instead of CSV. Fail clearly instead of silently treating it as data.
    if (
      /accounts\.google\.com|sign in to continue|request access|permission/i.test(text) &&
      !/^"?Name"?\s*,/i.test(text.trim())
    ) {
      throw new Error(
        'Google Sheet is not publicly readable. Share the sheet as "Anyone with the link" → Viewer.'
      );
    }

    const mapping = parseGoogleSheetCsv(text);

    learnerSheetCache = {
      loadedAt: now,
      mapping,
    };

    return mapping;
  } catch (err) {
    // Keep the last successful copy available during a temporary Google
    // Sheets/network failure. On a first load, rethrow so the problem is clear.
    if (learnerSheetCache.loadedAt && Object.keys(learnerSheetCache.mapping).length) {
      console.error('Learner Google Sheet refresh failed; using last successful copy:', err);
      return learnerSheetCache.mapping;
    }

    throw err;
  }
}

function normalizeLearnerEmail(value) {
  if (!value) return '';
  const m = /<([^>]+)>/.exec(String(value));
  let email = (m ? m[1] : String(value)).trim().toLowerCase().replace(/\s+/g, '');
  const at = email.indexOf('@');
  if (at > 0 && email.slice(at + 1).startsWith('ms.')) {
    email = email.slice(0, at + 1) + email.slice(at + 4);
  }
  return email;
}

function learnerRecord(mapping, value) {
  return mapping[normalizeLearnerEmail(value)] || null;
}

async function getVisibility(req, alias = 't') {
  const clauses = [];
  const params = [];

  if (!req.user.is_admin) {
    const fullAccessMailboxIds = await getFullAccessMailboxIds(req.user.id);
    if (fullAccessMailboxIds.length) {
      clauses.push(`(${alias}.assignee_id = ? OR ${alias}.mailbox_id = ANY(?))`);
      params.push(req.user.id, fullAccessMailboxIds);
    } else {
      clauses.push(`${alias}.assignee_id = ?`);
      params.push(req.user.id);
    }
  }

  const accessibleMailboxIds = await getAccessibleMailboxIds(req.user.id);
  if (accessibleMailboxIds !== null) {
    if (accessibleMailboxIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`${alias}.mailbox_id = ANY(?)`);
      params.push(accessibleMailboxIds);
    }
  }

  return {
    sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildLearnerCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const email = normalizeLearnerEmail(row.from_address);
    if (!email) continue;
    const current = counts.get(email) || { total: 0, open: 0, closed: 0, unassigned: 0, assigned: 0, replied: 0 };
    current.total += 1;
    if (row.status === 'closed') current.closed += 1;
    else current.open += 1;
    if (row.status === 'unassigned') current.unassigned += 1;
    else if (row.status === 'assigned') current.assigned += 1;
    else if (row.status === 'replied') current.replied += 1;
    counts.set(email, current);
  }
  return counts;
}

function learnerSla(tickets) {
  const eligible = tickets.filter((t) => t.first_received_at);
  let met = 0;
  const now = Date.now();
  for (const t of eligible) {
    const received = new Date(t.first_received_at).getTime();
    const firstReply = t.first_replied_at ? new Date(t.first_replied_at).getTime() : null;
    const resolution = t.closed_at ? new Date(t.closed_at).getTime() : (t.first_replied_at ? new Date(t.first_replied_at).getTime() : null);
    const firstOk = firstReply != null ? firstReply - received <= FIRST_REPLY_TARGET_H * 3600000 : now - received <= FIRST_REPLY_TARGET_H * 3600000;
    const resolutionOk = resolution != null ? resolution - received <= RESOLUTION_TARGET_H * 3600000 : now - received <= RESOLUTION_TARGET_H * 3600000;
    if (firstOk && resolutionOk) met += 1;
  }
  return {
    met,
    total: eligible.length,
    missed: eligible.length - met,
    percent: eligible.length ? Math.round((met / eligible.length) * 100) : null,
    first_response_target_hours: FIRST_REPLY_TARGET_H,
    resolution_target_hours: RESOLUTION_TARGET_H,
  };
}

async function logEvent(ticketId, actorId, eventType, detail) {
  await db
    .prepare(`INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES (?, ?, ?, ?)`)
    .run(ticketId, actorId, eventType, detail || null);
}

function serializeTicket(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    is_automated: !!row.is_automated,
    // Per-ticket TAT, computed live from the same milestone timestamps the
    // aggregate Dashboard/My Stats KPIs use - so every individual ticket
    // shows its own turnaround time as soon as it has a first response
    // (sent via the tool OR detected from a direct reply in Gmail), without
    // waiting for/depending on the aggregate views.
    tat: computeTicketTat(row),
  };
}

async function getTicketOr404(req, res) {
  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  return ticket;
}

// Non-admin ("agent") team members only ever get to see/act on tickets
// assigned to them - not the whole team's inbox - UNLESS they've been given
// "full access" to that specific mailbox (see the full_access column
// comment in db.js), in which case they see/act on every ticket in it, same
// as an admin would. Admins can see and touch everything *within their
// granted mailboxes* (mailbox_access is a separate, additional restriction
// from the admin/agent role - see services/mailboxAccess.js). Returns true
// (allowed) / false (should 403).
async function canAccessTicket(req, ticket) {
  const accessibleMailboxIds = await getAccessibleMailboxIds(req.user.id);
  if (!mailboxAllowed(accessibleMailboxIds, ticket.mailbox_id)) return false;
  if (req.user.is_admin) return true;
  if (ticket.assignee_id === req.user.id) return true;
  const fullAccessMailboxIds = await getFullAccessMailboxIds(req.user.id);
  return fullAccessMailboxIds.includes(ticket.mailbox_id);
}

async function requireTicketAccess(req, res, ticket) {
  if (!(await canAccessTicket(req, ticket))) {
    res.status(403).json({ error: 'You can only view or act on tickets assigned to you' });
    return false;
  }
  return true;
}

// GET /api/tickets - filterable list. Agents are hard-scoped to their own
// assigned tickets regardless of what filters they pass in.
router.get('/', async (req, res, next) => {
  try {
    const { mailbox_id, assignee_id, status, automated, tag, q, from_date, to_date } = req.query;

    const clauses = [];
    const params = [];

    // Date range filters by first_received_at (when the ticket originally
    // arrived), not received_at (which can move forward if the thread gets
    // follow-up messages) - so "tickets received between X and Y" stays
    // stable regardless of later back-and-forth. Postgres has no date()
    // function like SQLite - cast with ::date instead.
    if (from_date) {
      clauses.push('t.first_received_at::date >= ?::date');
      params.push(from_date);
    }
    if (to_date) {
      clauses.push('t.first_received_at::date <= ?::date');
      params.push(to_date);
    }

    if (!req.user.is_admin) {
      // Force-scope: agents can only ever see tickets assigned to them,
      // except in mailboxes where they've been given "full access" (see
      // full_access column comment in db.js) - there they see everything,
      // same as an admin would within that mailbox.
      const fullAccessMailboxIds = await getFullAccessMailboxIds(req.user.id);
      if (fullAccessMailboxIds.length) {
        clauses.push('(t.assignee_id = ? OR t.mailbox_id = ANY(?))');
        params.push(req.user.id, fullAccessMailboxIds);
      } else {
        clauses.push('t.assignee_id = ?');
        params.push(req.user.id);
      }
    } else if (assignee_id) {
      if (assignee_id === 'unassigned') {
        clauses.push('t.assignee_id IS NULL');
      } else {
        clauses.push('t.assignee_id = ?');
        params.push(assignee_id);
      }
    }

    // Mailbox access allow-list - a separate, additional restriction from
    // the admin/agent role above (see services/mailboxAccess.js). null
    // means unrestricted, so no clause is added for members who've never
    // had specific mailboxes granted.
    const accessibleMailboxIds = await getAccessibleMailboxIds(req.user.id);
    if (accessibleMailboxIds !== null) {
      if (accessibleMailboxIds.length === 0) {
        // Granted access to zero mailboxes - should see nothing, not
        // everything. `= ANY('{}')` never matches any row.
        clauses.push('1 = 0');
      } else {
        clauses.push('t.mailbox_id = ANY(?)');
        params.push(accessibleMailboxIds);
      }
    }

    if (mailbox_id) {
      clauses.push('t.mailbox_id = ?');
      params.push(mailbox_id);
    }
    if (status) {
      clauses.push('t.status = ?');
      params.push(status);
    }
    if (automated === 'true') {
      clauses.push('t.is_automated = 1');
    } else if (automated === 'false') {
      clauses.push('t.is_automated = 0');
    }
    if (tag) {
      clauses.push('t.tags LIKE ?');
      params.push(`%"${tag}"%`);
    }
    if (q) {
      clauses.push('(t.subject LIKE ? OR t.from_address LIKE ? OR t.snippet LIKE ? OR t.body LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db
      .prepare(
        `SELECT t.*, m.email AS mailbox_email, tm.name AS assignee_name
         FROM tickets t
         LEFT JOIN mailboxes m ON m.id = t.mailbox_id
         LEFT JOIN team_members tm ON tm.id = t.assignee_id
         ${where}
         ORDER BY t.received_at DESC
         LIMIT 500`
      )
      .all(...params);

    const visibility = await getVisibility(req, 't');
    const learnerRows = await db
      .prepare(`SELECT t.from_address, t.status FROM tickets t WHERE t.is_automated = 0 ${visibility.sql}`)
      .all(...visibility.params);
    const learnerCounts = buildLearnerCounts(learnerRows);
    const learnerMapping = await loadLearnerMapping();

    res.json({
      tickets: rows.map((row) => {
        const ticket = serializeTicket(row);
        const key = normalizeLearnerEmail(row.from_address);
        const mapping = learnerRecord(learnerMapping, row.from_address);
        const counts = learnerCounts.get(key) || { total: 0, open: 0, closed: 0, unassigned: 0, assigned: 0, replied: 0 };
        return {
          ...ticket,
          student_id: mapping ? mapping.student_id : null,
          learner_name: mapping ? mapping.name : null,
          learner_ticket_count: counts.total,
          learner_open_count: counts.open,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/learner/:email - learner history and cross-mailbox summary
router.get('/learner/:email', async (req, res, next) => {
  try {
    const requestedEmail = decodeURIComponent(req.params.email || '');
    const normalizedEmail = normalizeLearnerEmail(requestedEmail);
    if (!normalizedEmail) return res.status(400).json({ error: 'Learner email is required' });

    const learnerMapping = await loadLearnerMapping();
    const mapping = learnerMapping[normalizedEmail] || null;

    const visibility = await getVisibility(req, 't');
    const rows = await db
      .prepare(
        `SELECT t.*, m.email AS mailbox_email, tm.name AS assignee_name
         FROM tickets t
         LEFT JOIN mailboxes m ON m.id = t.mailbox_id
         LEFT JOIN team_members tm ON tm.id = t.assignee_id
         WHERE t.is_automated = 0
           AND (
             LOWER(TRIM(t.from_address)) = ?
             OR LOWER(TRIM(t.from_address)) LIKE '%<' || ? || '>%' 
           )
           ${visibility.sql}
         ORDER BY t.first_received_at DESC, t.received_at DESC`
      )
      .all(normalizedEmail, normalizedEmail, ...visibility.params);

    const tickets = rows.map(serializeTicket);
    const byStatus = { unassigned: 0, assigned: 0, replied: 0, closed: 0 };
    const byMailbox = new Map();
    for (const t of tickets) {
      if (Object.prototype.hasOwnProperty.call(byStatus, t.status)) byStatus[t.status] += 1;
      const mailbox = t.mailbox_email || 'Unknown';
      byMailbox.set(mailbox, (byMailbox.get(mailbox) || 0) + 1);
    }

    const total = tickets.length;
    const closed = byStatus.closed;
    const open = total - closed;
    const sla = learnerSla(rows);

    res.json({
      learner: {
        email: requestedEmail || normalizedEmail,
        student_id: mapping ? mapping.student_id : null,
        name: mapping ? mapping.name : null,
        status: mapping ? mapping.status : null,
      },
      counts: {
        total,
        open,
        closed,
        unassigned: byStatus.unassigned,
        first_response_pending: byStatus.assigned,
        replied: byStatus.replied,
      },
      sla,
      by_status: byStatus,
      by_mailbox: [...byMailbox.entries()].map(([mailbox, count]) => ({ mailbox, count })),
      tickets,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id - full detail incl. event history
router.get('/:id', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ticket.mailbox_id);
    // Note: a whole email thread now maps to a single ticket row (see
    // services/poller.js), so there's no separate "sibling tickets" concept
    // any more - new messages in the thread show up in the events/history list
    // below (thread_new_message / thread_reopened) instead.
    const events = await db
      .prepare(
        `SELECT e.*, tm.name AS actor_name FROM ticket_events e LEFT JOIN team_members tm ON tm.id = e.actor_id WHERE e.ticket_id = ? ORDER BY e.created_at`
      )
      .all(ticket.id);

    // Full conversation thread, oldest first - see the ticket_messages
    // table comment in db.js. Tickets created before this feature shipped
    // won't have any rows here (only tickets.body, which is still kept as a
    // fallback - see the frontend's ticket detail rendering).
    const messages = await db
      .prepare(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY sent_at`)
      .all(ticket.id);

    res.json({
      ticket: serializeTicket(ticket),
      mailbox_email: mailbox ? mailbox.email : null,
      events,
      messages,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/assign - admins can assign in any mailbox they
// have access to; non-admins can only assign within a mailbox they've been
// EXPLICITLY granted on the Team page (an actual mailbox_access row for
// them - full_access isn't required, just being granted that mailbox at
// all). A non-admin who's fully unrestricted (never had any mailbox
// specifically granted) still can't assign anything - "given access to a
// mailbox" means an explicit grant, not the unrestricted default.
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;

    const actingUserMailboxes = await getAccessibleMailboxIds(req.user.id);
    if (!mailboxAllowed(actingUserMailboxes, ticket.mailbox_id)) {
      return res.status(403).json({ error: "You don't have access to this ticket's mailbox" });
    }
    const canAssign = req.user.is_admin || (actingUserMailboxes !== null && actingUserMailboxes.includes(ticket.mailbox_id));
    if (!canAssign) {
      return res.status(403).json({
        error: 'Only an admin, or someone explicitly granted this mailbox on the Team page, can assign tickets',
      });
    }

    const { assignee_id } = req.body || {};
    if (assignee_id) {
      const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(assignee_id);
      if (!member) return res.status(400).json({ error: 'Unknown team member' });

      // Don't assign a ticket to someone who wouldn't be able to see it -
      // that'd be a ticket permanently stuck invisible to its own assignee.
      const assigneeMailboxes = await getAccessibleMailboxIds(assignee_id);
      if (!mailboxAllowed(assigneeMailboxes, ticket.mailbox_id)) {
        return res.status(400).json({
          error: "That team member doesn't have access to this ticket's mailbox - grant it on the Team page first",
        });
      }
    }

    const newStatus = assignee_id ? 'assigned' : ticket.status === 'assigned' ? 'unassigned' : ticket.status;

    // assigned_at is a TAT milestone: only ever set on the *first* assignment,
    // so reassigning a ticket later doesn't reset "time to first response".
    // The bare `? IS NOT NULL` check below needs an explicit ::int cast -
    // Postgres can't infer a type for a standalone parameter used only in an
    // IS NOT NULL check (error 42P18 "could not determine data type of
    // parameter"), unlike SQLite which never cared about param types.
    await db
      .prepare(
        `UPDATE tickets
         SET assignee_id = ?, status = ?, assigned_at = COALESCE(assigned_at, CASE WHEN ?::int IS NOT NULL THEN datetime('now') END), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(assignee_id || null, newStatus, assignee_id || null, ticket.id);

    await logEvent(
      ticket.id,
      req.user.id,
      'assign',
      assignee_id ? `Assigned to member #${assignee_id}` : 'Unassigned'
    );

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/status - manual status change (e.g. close)
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const { status } = req.body || {};
    const allowed = ['unassigned', 'assigned', 'replied', 'closed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    // closed_at is a TAT milestone: only set the first time a ticket is closed.
    await db
      .prepare(
        `UPDATE tickets
         SET status = ?, closed_at = COALESCE(closed_at, CASE WHEN ? = 'closed' THEN datetime('now') END), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(status, status, ticket.id);
    await logEvent(ticket.id, req.user.id, 'status_change', `Status set to ${status}`);

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/tags
router.patch('/:id/tags', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const { tags } = req.body || {};
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

    await db
      .prepare(`UPDATE tickets SET tags = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(clean), ticket.id);
    await logEvent(ticket.id, req.user.id, 'tags_change', clean.join(', '));

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/office-hours - sets (or clears) a scheduled
// office-hours slot for this ticket. Body: { office_hours_at: <ISO string
// or null> }. Setting a non-null value also adds an "office-hours" tag
// (if not already present) so it's visible/filterable the same way any
// other tag is, alongside the actual timestamp for later display/sorting.
router.patch('/:id/office-hours', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const { office_hours_at } = req.body || {};
    let parsed = null;
    if (office_hours_at !== null && office_hours_at !== undefined) {
      parsed = new Date(office_hours_at);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'office_hours_at must be a valid date/time or null' });
      }
    }

    let tags = JSON.parse(ticket.tags || '[]');
    if (parsed && !tags.some((t) => t.toLowerCase() === 'office-hours')) {
      tags = [...tags, 'office-hours'];
    }

    await db
      .prepare(
        `UPDATE tickets SET office_hours_at = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(parsed ? parsed.toISOString() : null, JSON.stringify(tags), ticket.id);

    await logEvent(
      ticket.id,
      req.user.id,
      'office_hours_set',
      parsed ? `Office hours slot set to ${parsed.toISOString()}` : 'Office hours slot cleared'
    );

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/automated - manual override of the auto heuristic.
// Setting this always sets automated_source='manual', so it sticks
// regardless of what the heuristic would have said.
router.patch('/:id/automated', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const { is_automated, reason } = req.body || {};
    if (typeof is_automated !== 'boolean') {
      return res.status(400).json({ error: 'is_automated must be a boolean' });
    }

    await db
      .prepare(
        `UPDATE tickets SET is_automated = ?, automated_source = 'manual', automated_reason = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(is_automated ? 1 : 0, reason || `Manually set by ${req.user.name}`, ticket.id);

    await logEvent(
      ticket.id,
      req.user.id,
      'automated_toggle',
      `Set is_automated=${is_automated} (manual override)`
    );

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

// Splits a comma-separated recipient field from the reply composer into a
// clean array of addresses, dropping anything blank.
function splitAddresses(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

// POST /api/tickets/:id/reply - send a real reply through Gmail, threaded.
// Body: { bodyText, bodyHtml, to, cc, bcc }. to/cc/bcc are comma-separated
// strings (or arrays) of addresses from the Reply/Reply All composer - see
// public/app.js. `to` defaults to the original sender if omitted, so a bare
// { bodyText } request still works the way a plain "Reply" always did.
router.post('/:id/reply', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    const { bodyText, bodyHtml, to, cc, bcc } = req.body || {};
    if (!bodyText || !bodyText.trim()) {
      return res.status(400).json({ error: 'Reply body is required' });
    }

    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ticket.mailbox_id);
    if (!mailbox || !mailbox.refresh_token) {
      return res.status(400).json({ error: 'Source mailbox is not connected' });
    }

    const adapter = PROVIDERS[mailbox.provider];
    if (!adapter) return res.status(500).json({ error: `No adapter for provider ${mailbox.provider}` });

    // Reply-to address: prefer the From header of the original message,
    // unless the composer explicitly provided recipients (Reply/Reply All).
    const toMatch = /<([^>]+)>/.exec(ticket.from_address || '');
    const defaultTo = toMatch ? toMatch[1] : ticket.from_address;
    const toList = splitAddresses(to);
    const ccList = splitAddresses(cc);
    const bccList = splitAddresses(bcc);
    if (toList.length === 0 && defaultTo) toList.push(defaultTo);
    if (toList.length === 0) {
      return res.status(400).json({ error: 'At least one To recipient is required' });
    }

    try {
      const sent = await adapter.sendReply(mailbox, {
        threadId: ticket.gmail_thread_id,
        messageIdHeader: ticket.message_id_header,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: ticket.subject,
        bodyText,
        bodyHtml,
      });

      await db
        .prepare(
          `UPDATE tickets SET status = 'replied', last_reply_mode = 'sent', first_replied_at = COALESCE(first_replied_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`
        )
        .run(ticket.id);
      await logEvent(ticket.id, req.user.id, 'reply_sent', `Sent via ${mailbox.email}`);

      await recordMessage(ticket.id, {
        gmailMessageId: sent && sent.id,
        direction: 'outbound',
        fromAddress: mailbox.email,
        toAddress: toList.join(', '),
        ccAddress: ccList.join(', '),
        body: bodyText,
        bodyHtml: bodyHtml || null,
        sentAt: new Date().toISOString(),
      });

      const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
      res.json({ ticket: serializeTicket(updated) });
    } catch (err) {
      console.error('[tickets] reply send failed:', err);
      res.status(502).json({ error: `Failed to send reply: ${err.message}` });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/mark-replied-externally
router.post('/:id/mark-replied-externally', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!(await requireTicketAccess(req, res, ticket))) return;

    await db
      .prepare(
        `UPDATE tickets SET status = 'replied', last_reply_mode = 'external', first_replied_at = COALESCE(first_replied_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`
      )
      .run(ticket.id);
    await logEvent(ticket.id, req.user.id, 'reply_marked_external', 'Marked replied externally (no email sent)');

    const updated = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    res.json({ ticket: serializeTicket(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
