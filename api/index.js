// Vercel serverless entrypoint. Vercel auto-detects any file under /api/ as
// a function; vercel.json rewrites every request (static files, the SPA,
// and /api/* routes alike) to this one function, which just hands the
// request to the same Express app used by the always-on entrypoint
// (src/server.js) - see src/app.js for the shared setup.
const { getApp } = require('../src/app');

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    // Without this, a failure during app setup (bad DATABASE_URL, migration
    // error, etc.) throws unhandled and Vercel shows a bare
    // FUNCTION_INVOCATION_FAILED page with no way to tell what went wrong.
    // Logging here means the real error shows up in Vercel's function logs,
    // and returning JSON (instead of crashing) means curl/the browser shows
    // something actionable too.
    console.error('[api/index] App failed to initialize:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server failed to start', detail: String(err && err.message || err) }));
  }
};
