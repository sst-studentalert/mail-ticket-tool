// Entrypoint for always-on deployments (Docker, Render, Railway, or plain
// `node src/server.js` locally). NOT used on Vercel - see api/index.js for
// that entrypoint, which shares the same app setup via src/app.js but never
// calls .listen() (Vercel handles the HTTP server itself).
const config = require('./config');
const { getApp } = require('./app');
const { startPoller } = require('./services/poller');

getApp()
  .then((app) => {
    app.listen(config.port, () => {
      console.log(`[server] Listening on port ${config.port} (${config.baseUrl})`);
      // No-op unless ENABLE_INTERNAL_POLLER=true (see config.js) - on
      // Vercel, polling instead runs via POST/GET /api/cron/poll on a
      // Vercel Cron Job schedule.
      startPoller();
    });
  })
  .catch((err) => {
    console.error('[server] Fatal error during startup:', err);
    process.exit(1);
  });
