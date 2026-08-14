const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pollAllMailboxes } = require('../services/poller');

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

// Manual "poll now" button for the Mailboxes admin page - runs the exact
// same pollAllMailboxes() pass the Vercel Cron Job / CRON_SECRET-gated
// /api/cron/poll endpoint uses, but gated by the normal admin session
// instead, so there's no need to go find/paste CRON_SECRET into curl just to
// force an immediate check (e.g. right after connecting a mailbox or
// resetting a checkpoint).
router.post('/poll-now', requireAdmin, async (req, res, next) => {
  try {
    await pollAllMailboxes();
    res.json({ ok: true, polledAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
