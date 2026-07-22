// Postgres (Neon-compatible) connection + a thin compatibility layer that
// mimics the small subset of the better-sqlite3 API this app was originally
// built against (`db.prepare(sql).get/all/run(...args)`), but async and
// backed by a real Postgres connection pool.
//
// Why this shape instead of rewriting every query from scratch: almost every
// route file was written against `db.prepare(sql).get(...)` etc. Keeping
// that exact call shape - just adding `await` in front of it - means the
// bulk of the migration is mechanical (add async/await) rather than
// rewriting SQL everywhere. The few places that genuinely need
// Postgres-specific SQL (TAT's julianday->EXTRACT(EPOCH), date() -> ::date,
// MIN(a,b) -> LEAST(a,b), INSERT ... RETURNING id) are called out inline
// where they occur.
const { Pool, types } = require('pg');
const config = require('./config');

// Postgres returns BIGINT (e.g. COUNT(*), SUM(integer)) as a string by
// default, to avoid silent precision loss for huge values. This app's
// numbers are always small (ticket counts for a handful of mailboxes/team
// members), so parsing them back to JS numbers is safe and avoids a whole
// class of "0" + "1" === "01"-style bugs across every count/sum query.
types.setTypeParser(20, (val) => parseInt(val, 10)); // int8 / bigint

if (!config.databaseUrl) {
  console.error(
    '[db] DATABASE_URL is not set. This app requires a Postgres connection ' +
      '(e.g. a Neon connection string). Set DATABASE_URL in your environment and restart.'
  );
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // Fires for errors on idle clients in the pool (e.g. a dropped connection)
  // - log it, don't crash the whole process over a single bad connection.
  console.error('[db] Unexpected idle client error:', err);
});

// Translates the handful of SQLite-flavored constructs still present in
// call-site SQL strings into Postgres equivalents, and converts `?`
// positional placeholders into Postgres's `$1, $2, ...`. This codebase
// never uses a literal `?` character inside a string literal in its SQL, so
// the naive global replace is safe here.
function translate(sql) {
  let out = sql.replace(/datetime\(\s*'now'\s*\)/gi, 'NOW()');
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);
  return out;
}

class Statement {
  constructor(sql) {
    this.sql = translate(sql);
  }
  async get(...params) {
    const { rows } = await pool.query(this.sql, params);
    return rows[0];
  }
  async all(...params) {
    const { rows } = await pool.query(this.sql, params);
    return rows;
  }
  // Mirrors better-sqlite3's `.run()` shape: `{ changes, lastInsertRowid }`.
  // For INSERTs where the caller needs the new id, add `RETURNING id` to the
  // SQL (a handful of call sites do this) and it shows up as
  // `lastInsertRowid` here, same as before.
  async run(...params) {
    const result = await pool.query(this.sql, params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows && result.rows[0] ? result.rows[0].id : undefined,
      rows: result.rows,
    };
  }
}

const db = {
  prepare(sql) {
    return new Statement(sql);
  },
  async exec(sql) {
    await pool.query(translate(sql));
  },
  pool,
};

// --- Schema (idempotent - safe to run on every boot) ---------------------
// `ADD COLUMN IF NOT EXISTS` (Postgres 9.6+) replaces the old
// PRAGMA-table_info-based "add column if missing" dance SQLite needed.

async function migrate() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mailboxes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'gmail',
      refresh_token TEXT,
      access_token TEXT,
      token_expiry BIGINT,
      last_history_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_internal_date TEXT,
      last_sent_internal_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      gmail_thread_id TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL UNIQUE,
      message_id_header TEXT,
      from_address TEXT,
      subject TEXT,
      snippet TEXT,
      body TEXT,
      received_at TIMESTAMPTZ,
      first_received_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'unassigned',
      assignee_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      is_automated INTEGER NOT NULL DEFAULT 0,
      automated_reason TEXT,
      automated_source TEXT NOT NULL DEFAULT 'auto',
      last_reply_mode TEXT,
      assigned_at TIMESTAMPTZ,
      first_replied_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_mailbox ON tickets(mailbox_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_thread ON tickets(gmail_thread_id);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Belt-and-suspenders for columns added after the tables above already
    -- existed in an earlier version of this schema (harmless no-ops on a
    -- brand new database).
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_received_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_replied_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS last_sent_internal_date TEXT;

    UPDATE tickets SET first_received_at = received_at WHERE first_received_at IS NULL;
  `);
}

// Callers (server.js, scripts/*) must `await` this once at startup before
// the app starts handling requests. Exported instead of run automatically
// on require() because it's async now (Postgres schema setup can't happen
// synchronously the way SQLite's could).
db.migrate = migrate;

module.exports = db;
