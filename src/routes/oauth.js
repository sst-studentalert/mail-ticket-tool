// Google OAuth "Connect mailbox" flow. Any logged-in team member can start
// this from the Mailboxes admin page; the mailbox owner completes the Google
// consent screen themselves (no password sharing required).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const gmailAdapter = require('../services/gmailAdapter');

const router = express.Router();

// The OAuth `state` param protects the callback against CSRF - it has to
// prove the callback corresponds to a /start call we actually issued.
// Previously this was tracked in an in-memory Map, which worked locally but
// broke on Vercel: serverless function instances aren't guaranteed to
// persist that Map between the /start and /callback requests if they land
// on different instances (very likely across two separate requests, since
// each invocation can spin up fresh) - surfacing as "invalid_state" on
// every connect attempt. Fixed by making state a signed, stateless token
// instead: it carries its own payload (who started it, when) and an HMAC
// signature keyed on SESSION_SECRET, so any instance can verify it without
// needing to have seen the /start request itself.
function signState(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifyState(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('base64url');
  // Constant-time comparison to avoid a timing side-channel on the signature check.
  const sigBuf = Buffer.from(signature || '');
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (Date.now() - payload.createdAt > 10 * 60 * 1000) return null; // expired (10 min)
    return payload;
  } catch {
    return null;
  }
}

// Only admins can connect mailboxes (the callback itself is unauthenticated
// by necessity - it's Google redirecting the browser back - but it's gated
// by the signed `state` token minted here, which we only ever hand out to
// an admin session).
router.get('/google/start', requireAuth, requireAdmin, (req, res) => {
  const state = signState({ userId: req.user.id, createdAt: Date.now() });
  const url = gmailAdapter.getAuthUrl(state);
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/index.html?mailbox_error=${encodeURIComponent(String(error))}#mailboxes`);
  }
  if (!code || !verifyState(String(state || ''))) {
    return res.redirect('/index.html?mailbox_error=invalid_state#mailboxes');
  }

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
