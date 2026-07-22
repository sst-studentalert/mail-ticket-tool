const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const gmailAdapter = require('../services/gmailAdapter');
const { computeTicketTat } = require('../services/tat');

const router = express.Router();
router.use(requireAuth);

const PROVIDERS = { gmail: gmailAdapter };

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
// assigned to them - not the whole team's inbox. Admins can see and touch
// everything. Returns true (allowed) / false (should 403).
function canAccessTicket(req, ticket) {
  if (req.user.is_admin) return true;
  return ticket.assignee_id === req.user.id;
}

function requireTicketAccess(req, res, ticket) {
  if (!canAccessTicket(req, ticket)) {
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
      // Force-scope: agents can only ever see tickets assigned to them.
      clauses.push('t.assignee_id = ?');
      params.push(req.user.id);
    } else if (assignee_id) {
      if (assignee_id === 'unassigned') {
        clauses.push('t.assignee_id IS NULL');
      } else {
        clauses.push('t.assignee_id = ?');
        params.push(assignee_id);
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

    res.json({ tickets: rows.map(serializeTicket) });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id - full detail incl. event history
router.get('/:id', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!requireTicketAccess(req, res, ticket)) return;

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

    res.json({
      ticket: serializeTicket(ticket),
      mailbox_email: mailbox ? mailbox.email : null,
      events,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id/assign - admin only. Agents can't reassign tickets
// (including their own), since they only have visibility into their own
// queue in the first place.
router.patch('/:id/assign', requireAdmin, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;

    const { assignee_id } = req.body || {};
    if (assignee_id) {
      const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(assignee_id);
      if (!member) return res.status(400).json({ error: 'Unknown team member' });
    }

    const newStatus = assignee_id ? 'assigned' : ticket.status === 'assigned' ? 'unassigned' : ticket.status;

    // assigned_at is a TAT milestone: only ever set on the *first* assignment,
    // so reassigning a ticket later doesn't reset "time to first response".
    await db
      .prepare(
        `UPDATE tickets
         SET assignee_id = ?, status = ?, assigned_at = COALESCE(assigned_at, CASE WHEN ? IS NOT NULL THEN datetime('now') END), updated_at = datetime('now')
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
    if (!requireTicketAccess(req, res, ticket)) return;

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
    if (!requireTicketAccess(req, res, ticket)) return;

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

// PATCH /api/tickets/:id/automated - manual override of the auto heuristic.
// Setting this always sets automated_source='manual', so it sticks
// regardless of what the heuristic would have said.
router.patch('/:id/automated', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!requireTicketAccess(req, res, ticket)) return;

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

// POST /api/tickets/:id/reply - send a real reply through Gmail, threaded.
router.post('/:id/reply', async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res);
    if (!ticket) return;
    if (!requireTicketAccess(req, res, ticket)) return;

    const { body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Reply body is required' });
    }

    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ticket.mailbox_id);
    if (!mailbox || !mailbox.refresh_token) {
      return res.status(400).json({ error: 'Source mailbox is not connected' });
    }

    const adapter = PROVIDERS[mailbox.provider];
    if (!adapter) return res.status(500).json({ error: `No adapter for provider ${mailbox.provider}` });

    // Reply-to address: prefer the From header of the original message.
    const toMatch = /<([^>]+)>/.exec(ticket.from_address || '');
    const to = toMatch ? toMatch[1] : ticket.from_address;

    try {
      await adapter.sendReply(mailbox, {
        threadId: ticket.gmail_thread_id,
        messageIdHeader: ticket.message_id_header,
        to,
        subject: ticket.subject,
        bodyText: body,
      });

      await db
        .prepare(
          `UPDATE tickets SET status = 'replied', last_reply_mode = 'sent', first_replied_at = COALESCE(first_replied_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`
        )
        .run(ticket.id);
      await logEvent(ticket.id, req.user.id, 'reply_sent', `Sent via ${mailbox.email}`);

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
    if (!requireTicketAccess(req, res, ticket)) return;

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
