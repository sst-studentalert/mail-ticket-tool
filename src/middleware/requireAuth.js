// Guards API routes: requires an active session with a valid user id.
const { findUserById, publicUser } = require('../services/auth');

async function requireAuth(req, res, next) {
  try {
    const userId = req.session && req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = await findUserById(userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    req.user = publicUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;
