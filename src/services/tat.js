// Shared per-ticket TAT (turnaround time) calculation, used by the tickets
// API so every individual ticket shows its own TAT the moment it has a
// first response - not just the aggregate KPIs on the Dashboard/My Stats
// (those keep computing the same way they always have, straight from SQL).
//
// Definitions (mirrors src/routes/stats.js and src/routes/myStats.js):
//   - first response = earliest of assigned_at / first_replied_at
//   - resolution      = closed_at, falling back to first_replied_at

// Postgres (via node-postgres) returns TIMESTAMPTZ columns as native JS Date
// objects already, so most of the time this is just a pass-through. Kept
// tolerant of plain strings too (e.g. a raw ISO string, or the old SQLite
// "YYYY-MM-DD HH:MM:SS" shape with no timezone marker, which is UTC) so
// this still works if a value comes from somewhere unexpected.
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDuration(seconds) {
  if (seconds == null) return null;
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && mins) parts.push(`${mins}m`);
  if (!parts.length) parts.push('<1m');
  return parts.join(' ');
}

function earliest(a, b) {
  if (a && b) return a < b ? a : b;
  return a || b || null;
}

// Returns { first_response: {seconds, human}, resolution: {seconds, human} }
// for a single ticket row (as returned by `SELECT * FROM tickets`). Both
// are null/"—" until the relevant milestone has actually happened.
function computeTicketTat(ticket) {
  const firstReceived = toDate(ticket.first_received_at || ticket.received_at);

  const firstResponseAt = earliest(ticket.assigned_at, ticket.first_replied_at);
  const resolutionAt = ticket.closed_at || ticket.first_replied_at || null;

  function build(milestoneRaw) {
    const milestone = toDate(milestoneRaw);
    if (!firstReceived || !milestone) {
      return { seconds: null, human: null };
    }
    const seconds = (milestone.getTime() - firstReceived.getTime()) / 1000;
    return { seconds, human: fmtDuration(seconds) };
  }

  return {
    first_response: build(firstResponseAt),
    resolution: build(resolutionAt),
  };
}

module.exports = { computeTicketTat, fmtDuration, toDate };
