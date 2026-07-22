const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();
router.use(requireAuth);

function publicMailbox(row) {
  const { refresh_token, access_token, ...rest } = row;
  return { ...rest, connected: !!refresh_token };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.prepare('SELECT * FROM mailboxes ORDER BY email').all();
    res.json({ mailboxes: rows.map(publicMailbox) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

    // Disconnect (clear tokens) rather than hard-delete, so ticket history /
    // foreign keys stay intact and it can be reconnected later.
    await db
      .prepare(
        `UPDATE mailboxes SET refresh_token = NULL, access_token = NULL, token_expiry = NULL, status = 'disconnected', updated_at = datetime('now') WHERE id = ?`
      )
      .run(id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
