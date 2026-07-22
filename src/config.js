// Centralized env loading. Every other module reads config from here instead
// of touching process.env directly, so it's obvious what the app depends on.
require('dotenv').config();

const path = require('path');

function required(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    return undefined;
  }
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: required('BASE_URL', 'http://localhost:3000'),
  sessionSecret: required('SESSION_SECRET', 'dev-only-insecure-secret'),

  adminEmail: process.env.ADMIN_EMAIL || '',
  adminName: process.env.ADMIN_NAME || 'Admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // Postgres connection string (Neon, or any Postgres, including a local one
  // for Docker-based dev). Required - there is no SQLite fallback any more.
  databaseUrl: process.env.DATABASE_URL || '',
  // Neon (and most managed Postgres) requires SSL. Disable only for a local
  // Postgres container that isn't configured for it.
  databaseSsl: (process.env.DATABASE_SSL || 'true') !== 'false',

  pollCron: process.env.POLL_CRON || '*/3 * * * *',

  // On Vercel there's no long-running process to run node-cron in, so the
  // poller runs via a Vercel Cron Job hitting POST /api/cron/poll instead
  // (see src/routes/cron.js + vercel.json). Set this to "true" for
  // Docker/local/Render-style deployments where an always-on process exists
  // and the in-process node-cron scheduler should just run directly like
  // before. Defaults to "false" so a plain `vercel deploy` doesn't
  // accidentally spin up a scheduler that can't do anything useful there.
  enableInternalPoller: process.env.ENABLE_INTERNAL_POLLER === 'true',

  // Shared secret the /api/cron/poll endpoint checks for, so it can't be
  // triggered by randoms hitting the URL. Vercel Cron Jobs can be configured
  // to send this as a header - see README.
  cronSecret: process.env.CRON_SECRET || '',

  automatedScoreThreshold: parseInt(process.env.AUTOMATED_SCORE_THRESHOLD || '2', 10),
};

// OAuth redirect URI used both when building the Google consent URL and when
// registering the credential in Google Cloud Console. Keep this single source
// of truth so the two never drift apart.
config.googleRedirectUri = `${config.baseUrl.replace(/\/$/, '')}/api/oauth/google/callback`;

// Gmail scopes: minimal footprint. readonly to list/read messages, send to
// reply. (Not gmail.modify - we never need to mutate labels/read-state.)
config.gmailScopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

module.exports = config;
