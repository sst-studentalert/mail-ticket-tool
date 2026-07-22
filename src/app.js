// Builds the Express app. Split out from server.js so both the always-on
// entrypoint (server.js, used by Docker/Render/local `npm start`) and the
// Vercel serverless entrypoint (api/index.js) can share the exact same app
// setup - including the async bits (running Postgres migrations, bootstrapping
// the first admin user, wiring up the Postgres-backed session store) that a
// plain `require()` can't do since they're no longer synchronous like the
// old SQLite version was.
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./config');
const db = require('./db');
const { bootstrapAdmin } = require('./services/auth');

const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');
const mailboxRoutes = require('./routes/mailboxes');
const ticketRoutes = require('./routes/tickets');
const rosterRoutes = require('./routes/roster');
const statsRoutes = require('./routes/stats');
const myStatsRoutes = require('./routes/myStats');
const cronRoutes = require('./routes/cron');

let appPromise = null;

// Builds (once) and returns the configured Express app. Safe to call
// repeatedly - subsequent calls reuse the same in-flight/completed promise,
// which matters on Vercel where a warm serverless instance handles multiple
// requests and shouldn't redo migrations/session-store setup on every one.
function getApp() {
  if (!appPromise) appPromise = buildApp();
  return appPromise;
}

async function buildApp() {
  await db.migrate();
  await bootstrapAdmin();

  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use(
    session({
      store: new pgSession({
        pool: db.pool,
        // Auto-creates the `session` table on first run - one less manual
        // migration step for Neon/any Postgres.
        createTableIfMissing: true,
      }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        // Serverless instances (Vercel) don't share in-memory state, and
        // there can be more than one of this app running at once even
        // outside serverless (e.g. behind a load balancer) - a database-
        // backed session store is what makes login work correctly in
        // either case, unlike the old in-memory MemoryStore.
      },
    })
  );

  // Health check - useful for docker-compose healthchecks and for verifying
  // the process/deployment is alive before real Google credentials are
  // configured.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/oauth', oauthRoutes);
  app.use('/api/mailboxes', mailboxRoutes);
  app.use('/api/tickets', ticketRoutes);
  app.use('/api/roster', rosterRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/my-stats', myStatsRoutes);
  app.use('/api/cron', cronRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // SPA fallback for any non-API GET route.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { getApp };
