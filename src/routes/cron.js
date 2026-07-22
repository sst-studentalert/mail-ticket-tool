// Triggers a single poller pass on demand - this is what makes polling work
// on Vercel, where there's no always-on process for node-cron to run in.
// Configure a Vercel Cron Job to hit this path on a schedule (see
// vercel.json + README). Also handy to hit manually while testing.
//
// Auth: if CRON_SECRET is set, requires it either as the
// `Authorization: Bearer <secret>` header (this is the header Vercel Cron
// automatically sends when a project env var named CRON_SECRET is set - see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs),
// or as an `x-cron-secret` header / `?secret=` query param for manual/local
// triggering. If CRON_SECRET isn't set at all, the endpoint is open - fine
// for local/Docker testing, but set CRON_SECRET before exposing this
// publicly on a real deployment.
const express = require('express');
const config = require('../config');
const { pollAllMailboxes } = require('../services/poller');

const router = express.Router();

function isAuthorized(req) {
  if (!config.cronSecret) return true;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${config.cronSecret}`) return true;
  if (req.headers['x-cron-secret'] === config.cronSecret) return true;
  if (req.query.secret === config.cronSecret) return true;
  return false;
}

async function handlePoll(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await pollAllMailboxes();
    res.json({ ok: true, polledAt: new Date().toISOString() });
  } catch (err) {
    console.error('[cron] Poll failed:', err);
    res.status(500).json({ error: 'Poll failed', detail: err.message });
  }
}

// Vercel Cron Jobs send GET by default; POST supported too for manual/other
// triggers (e.g. an uptime pinger or a manual curl).
router.get('/poll', handlePoll);
router.post('/poll', handlePoll);

module.exports = router;
