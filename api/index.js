// Vercel serverless entrypoint. Vercel auto-detects any file under /api/ as
// a function; vercel.json rewrites every request (static files, the SPA,
// and /api/* routes alike) to this one function, which just hands the
// request to the same Express app used by the always-on entrypoint
// (src/server.js) - see src/app.js for the shared setup.
const { getApp } = require('../src/app');

module.exports = async (req, res) => {
  const app = await getApp();
  return app(req, res);
};
