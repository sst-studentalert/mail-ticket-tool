// Guards routes that only admins may use. Must run after requireAuth (relies
// on req.user being set). Non-admin team members ("agents") get a 403.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = requireAdmin;
