// Password hashing helpers + first-run admin bootstrap.
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');

const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

async function findUserByEmail(email) {
  return db
    .prepare('SELECT * FROM team_members WHERE lower(email) = lower(?)')
    .get(email);
}

async function findUserById(id) {
  return db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return { ...rest, is_admin: !!rest.is_admin };
}

// Creates the very first admin account from env vars if the roster is empty.
// Safe to call on every boot - it's a no-op once any user exists.
async function bootstrapAdmin() {
  const { c: count } = await db.prepare('SELECT COUNT(*) AS c FROM team_members').get();
  if (count > 0) return;

  if (!config.adminEmail || !config.adminPassword) {
    console.warn(
      '[auth] No team members exist yet and ADMIN_EMAIL/ADMIN_PASSWORD are not set. ' +
        'Set them in .env and restart to create the first login.'
    );
    return;
  }

  const hash = hashPassword(config.adminPassword);
  await db
    .prepare(`INSERT INTO team_members (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)`)
    .run(config.adminName, config.adminEmail, hash);

  console.log(`[auth] Bootstrapped initial admin user: ${config.adminEmail}`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  findUserByEmail,
  findUserById,
  publicUser,
  bootstrapAdmin,
};
