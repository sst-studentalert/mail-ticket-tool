// Tiny generic settings store (see app_settings table comment in db.js).
// Currently used for exactly one value: the "office hours" contact email
// shown/edited on the Office Hours tab and used to prefill the Reply "To"
// field on office-hours-tagged tickets. Kept as a generic /:key route so
// adding another admin-editable setting later doesn't need a new table.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();
router.use(requireAuth);

// Everyone (not just admins) can READ settings - e.g. any agent opening an
// office-hours ticket needs the contact email to prefill Reply "To", not
// just admins.
router.get('/:key', async (req, res, next) => {
  try {
    const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(req.params.key);
    res.json({ key: req.params.key, value: row ? row.value : null });
  } catch (err) {
    next(err);
  }
});

// Only admins can change settings.
router.put('/:key', requireAdmin, async (req, res, next) => {
  try {
    const { value } = req.body;
    await db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      )
      .run(req.params.key, value == null ? null : String(value));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
