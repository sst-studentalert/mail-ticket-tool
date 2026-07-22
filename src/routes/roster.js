// Team roster admin: add/remove team members. Reading the roster (needed to
// populate assignee dropdowns/names) is open to any logged-in member;
// adding/removing members is admin-only.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { hashPassword, publicUser } = require('../services/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.prepare('SELECT * FROM team_members ORDER BY name').all();
    res.json({ members: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, is_admin } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    const existing = await db.prepare('SELECT id FROM team_members WHERE lower(email) = lower(?)').get(email);
    if (existing) {
      return res.status(409).json({ error: 'A team member with that email already exists' });
    }

    const hash = hashPassword(password);
    const info = await db
      .prepare('INSERT INTO team_members (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?) RETURNING id')
      .run(name, email, hash, is_admin ? 1 : 0);

    const created = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ member: publicUser(created) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/roster/:id - edit a team member.
// - Admins can edit anyone: name, email, is_admin, and optionally reset the
//   password.
// - Non-admins can only edit their OWN name and/or password (not email or
//   is_admin) - simple self-service so someone can fix a typo'd name or
//   change their own password without needing an admin to do it for them.
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    const isSelf = Number(id) === req.user.id;
    if (!req.user.is_admin && !isSelf) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name, email, password, is_admin } = req.body || {};
    const fields = [];
    const values = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      fields.push('name = ?');
      values.push(name.trim());
    }

    if (email !== undefined) {
      if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Only an admin can change email addresses' });
      }
      if (!email.trim()) return res.status(400).json({ error: 'Email cannot be empty' });
      const existing = await db
        .prepare('SELECT id FROM team_members WHERE lower(email) = lower(?) AND id != ?')
        .get(email, id);
      if (existing) return res.status(409).json({ error: 'A team member with that email already exists' });
      fields.push('email = ?');
      values.push(email.trim());
    }

    if (is_admin !== undefined) {
      if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Only an admin can change admin status' });
      }
      if (isSelf && !is_admin) {
        return res.status(400).json({ error: "You can't remove your own admin access while logged in as it." });
      }
      fields.push('is_admin = ?');
      values.push(is_admin ? 1 : 0);
    }

    if (password !== undefined) {
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      fields.push('password_hash = ?');
      values.push(hashPassword(password));
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(id);
    await db
      .prepare(`UPDATE team_members SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values);

    const updated = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
    res.json({ member: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (Number(id) === req.user.id) {
      return res.status(400).json({ error: "You can't remove your own account while logged in as it." });
    }
    const member = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    await db.prepare('DELETE FROM team_members WHERE id = ?').run(id);
    // Unassign any tickets that pointed at this member.
    await db
      .prepare("UPDATE tickets SET assignee_id = NULL, updated_at = datetime('now') WHERE assignee_id = ?")
      .run(id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
