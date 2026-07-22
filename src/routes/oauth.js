// Google OAuth "Connect mailbox" flow. Any logged-in team member can start
// this from the Mailboxes admin page; the mailbox owner completes the Google
// consent screen themselves (no password sharing required).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const gmailAdapter = require('../services/gmailAdapter');

const router = express.Router();

// Short-lived in-memory state store to protect against CSRF on the OAuth
// callback. Fine for a single-instance MVP deployment. NOTE: on Vercel,
// serverless function instances aren't guaranteed to persist this Map
// between the /start and /callback requests if they land on different
// instances - if you deploy there and hit "invalid_state" errors on
// connect, this in-memory store is why; swap it for a short-lived row in
// Postgres (or a signed, stateless token) if that happens in practice.
const pendingStates = new Map();

// Only admins can connect mailboxes (the callback itself is unauthenticated
// by necessity - it's Google redirecting the browser back - but it's gated
// by the one-time `state` token minted here, which we only ever hand out to
// an admin session).
router.get('/google/start', requireAuth, requireAdmin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { userId: req.user.id, createdAt: Date.now() });

  // Clean up old entries opportunistically.
  for (const [key, value] of pendingStates) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingStates.delete(key);
  }

  const url = gmailAdapter.getAuthUrl(state);
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/index.html?mailbox_error=${encodeURIComponent(String(error))}#mailboxes`);
  }
  if (!code || !state || !pendingStates.has(String(state))) {
    return res.redirect('/index.html?mailbox_error=invalid_state#mailboxes');
  }
  pendingStates.delete(String(state));

  try {
    const { email, refreshToken, accessToken, expiryDate } = await gmailAdapter.handleOAuthCallback(
      String(code)
    );

    if (!refreshToken) {
      // Happens if Google didn't return a refresh token (e.g. user already
      // granted consent previously without revoking). We force prompt=consent
      // in getAuthUrl to avoid this, but guard anyway.
      return res.redirect(
        '/index.html?mailbox_error=no_refresh_token_try_revoking_and_reconnecting#mailboxes'
      );
    }

    // Stamp the connection moment as the mailbox's sync baseline (both for
    // the inbox and the sent-folder checkpoints). Without this, they'd stay
    // NULL until the poller's first run, which then has no "after" filter
    // and backfills the whole inbox/sent history (up to the safety cap) -
    // not what we want for a fresh connection. Only mail from after this
    // moment should become a ticket or count as a detected reply.
    const nowMs = String(Date.now());

    const existing = await db.prepare('SELECT id FROM mailboxes WHERE email = ?').get(email);
    if (existing) {
      await db
        .prepare(
          `UPDATE mailboxes SET refresh_token = ?, access_token = ?, token_expiry = ?, status = 'connected', last_internal_date = COALESCE(last_internal_date, ?), last_sent_internal_date = COALESCE(last_sent_internal_date, ?), updated_at = datetime('now') WHERE id = ?`
        )
        .run(refreshToken, accessToken, expiryDate, nowMs, nowMs, existing.id);
    } else {
      await db
        .prepare(
          `INSERT INTO mailboxes (email, provider, refresh_token, access_token, token_expiry, status, last_internal_date, last_sent_internal_date) VALUES (?, 'gmail', ?, ?, ?, 'connected', ?, ?)`
        )
        .run(email, refreshToken, accessToken, expiryDate, nowMs, nowMs);
    }

    res.redirect('/index.html?mailbox_connected=1#mailboxes');
  } catch (err) {
    console.error('[oauth] callback failed:', err);
    res.redirect(`/index.html?mailbox_error=${encodeURIComponent(err.message)}#mailboxes`);
  }
});

module.exports = router;
