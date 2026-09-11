// Plain vanilla-JS single-page app. No build step, no framework - just
// fetch() against the REST API and manual DOM rendering. Keep it this way;
// the goal is that anyone comfortable with basic JS can read and modify it.

const state = {
  user: null,
  mailboxes: [],
  roster: [],
  tickets: [],
  filters: { mailbox_id: '', assignee_id: '', status: '', automated: '', tag: '', q: '', from_date: '', to_date: '' },
  statsFilters: { preset: 'month', from_date: '', to_date: '', mailbox_ids: null, unit: '#' },
  myStatsFilters: { from_date: '', to_date: '' },
  personId: null,
  showOverdue: false,
  statsRange: 'month',
  page: 'tickets',
  openTicketId: null,
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Bootstrapping / routing ----------

async function boot() {
  window.addEventListener('hashchange', onHashChange);
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    await loadShellData();
    onHashChange();
  } catch {
    renderLogin();
  }
}

const ADMIN_ONLY_PAGES = ['stats', 'mailboxes', 'roster'];

function onHashChange() {
  const hash = (location.hash || '#tickets').replace('#', '');
  let page = hash.split('?')[0] || 'tickets';

  // When the user navigates back to the Dashboard from another tab,
  // always return to the main Dashboard rather than the last person
  // drill-down they opened.
  if (page === 'stats') {
    state.personId = null;
    state.showOverdue = false;
  }

  // Agents (non-admins) only ever get the Tickets page.
  if (ADMIN_ONLY_PAGES.includes(page) && !(state.user && state.user.is_admin)) {
    page = 'tickets';
    location.hash = 'tickets';
  }

  state.page = page;
  renderApp();
}

async function loadShellData() {
  const [mb, roster] = await Promise.all([api('/mailboxes'), api('/roster')]);
  state.mailboxes = mb.mailboxes;
  state.roster = roster.members;
}

// ---------- Login ----------

function renderLogin() {
  const params = new URLSearchParams(location.search);
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <h1>Mail Ticket Tool</h1>
        <div id="login-error"></div>
        <form id="login-form">
          <label>Email</label>
          <input type="email" id="login-email" required />
          <label>Password</label>
          <input type="password" id="login-password" required />
          <div style="margin-top:16px;">
            <button type="submit" style="width:100%;">Log in</button>
          </div>
        </form>
      </div>
    </div>
  `;
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('login-email').value.trim();
    const password = el('login-password').value;
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      state.user = user;
      await loadShellData();
      onHashChange();
    } catch (err) {
      el('login-error').innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ---------- Shell / layout ----------

function initTheme() {
  const saved = localStorage.getItem('mail-ticket-theme');
  document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
}

function updateThemeToggle() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const icon = el('theme-toggle-icon');
  const label = el('theme-toggle-label');
  if (icon) icon.textContent = dark ? '☀' : '☾';
  if (label) label.textContent = dark ? 'Light' : 'Dark';
}

function renderApp() {
  const app = document.getElementById('app');
  const nav = [
    ['tickets', 'Tickets'],
    ['officehours', 'Office Hours'],
    ['mystats', 'My Stats'],
    ...(state.user.is_admin
      ? [
          ['stats', 'Dashboard'],
          ['mailboxes', 'Mailboxes'],
          ['roster', 'Team'],
        ]
      : []),
  ];

  app.innerHTML = `
    <div class="topbar">
      <div class="brand">Mail Ticket Tool</div>
      <nav>
        ${nav
          .map(
            ([key, label]) =>
              `<a data-nav="${key}" class="${state.page === key ? 'active' : ''}">${label}</a>`
          )
          .join('')}
      </nav>
      <div class="user">
        <span>${escapeHtml(state.user.name)} (${escapeHtml(state.user.email)})</span>
        <button class="secondary theme-toggle" id="theme-toggle" type="button"><span id="theme-toggle-icon">☀</span> <span id="theme-toggle-label">Light</span></button>
        <button class="secondary" id="my-account-btn">My account</button>
        <button class="secondary" id="logout-btn">Log out</button>
      </div>
    </div>
    <main id="main"></main>
  `;

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', () => {
      location.hash = a.dataset.nav;
    });
  });
  el('logout-btn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    renderLogin();
  });
  el('my-account-btn').addEventListener('click', () => openEditMember(state.user.id));
  el('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('mail-ticket-theme', next);
    updateThemeToggle();
  });
  updateThemeToggle();

  const params = new URLSearchParams(location.search);
  const banner = [];
  if (params.get('mailbox_connected')) banner.push('<div class="info-banner">Mailbox connected successfully.</div>');
  if (params.get('mailbox_error')) banner.push(`<div class="error-banner">Mailbox connection failed: ${escapeHtml(params.get('mailbox_error'))}</div>`);

  const mainHtml = banner.join('');
  el('main').innerHTML = mainHtml;

 if (state.page === 'stats') { renderStats(); }
  else if (state.page === 'mystats') renderMyStats();
  else if (state.page === 'mailboxes') renderMailboxes();
  else if (state.page === 'roster') renderRoster();
  else if (state.page === 'officehours') renderOfficeHours();
  else renderTickets();
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Pulls bare email addresses out of a raw header value like
// `"Name" <a@x.com>, b@y.com` - mirrors extractEmails in poller.js, used
// here to prefill Reply All from the original message's To/Cc.
function extractEmails(headerValue) {
  if (!headerValue) return [];
  const matches = headerValue.match(/[^\s<>,"]+@[^\s<>,"]+/g);
  return matches ? matches.map((e) => e.toLowerCase()) : [];
}

function extractEmail(headerValue) {
  return extractEmails(headerValue)[0] || headerValue || '';
}

// Converts an ISO timestamp to the "YYYY-MM-DDTHH:mm" format a
// <input type="datetime-local"> expects, in the browser's local timezone -
// used to prefill the Office hours picker when changing an existing slot.
function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Tickets list ----------

async function renderTickets() {
  const main = el('main');
  const isAdmin = state.user.is_admin;

  // Read ticket filters passed in the hash, e.g. when opening the
  // Dashboard's Unassigned queue. This keeps the date range and assignee
  // filter when moving from Dashboard -> Tickets.
  const hashQuery = location.hash.includes('?')
    ? location.hash.slice(location.hash.indexOf('?') + 1)
    : '';
  const hashParams = new URLSearchParams(hashQuery);
  if (hashParams.has('assignee_id') || hashParams.has('from_date') || hashParams.has('to_date')) {
    state.filters = {
      ...state.filters,
      assignee_id: hashParams.get('assignee_id') || '',
      from_date: hashParams.get('from_date') || '',
      to_date: hashParams.get('to_date') || '',
    };
  }
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header">
      <h2 style="margin:0;">Tickets</h2>
    </div>
    ${!isAdmin ? '<p class="small">Showing tickets assigned to you.</p>' : ''}
    <div class="filters">
      <div>
        <label>Mailbox</label>
        <select id="f-mailbox">
          <option value="">All</option>
          ${state.mailboxes.map((m) => `<option value="${m.id}">${escapeHtml(m.email)}</option>`).join('')}
        </select>
      </div>
      ${isAdmin ? `
      <div>
        <label>Assignee</label>
        <select id="f-assignee">
          <option value="">All</option>
          <option value="unassigned" ${state.filters.assignee_id === 'unassigned' ? 'selected' : ''}>Unassigned</option>
          ${state.roster.map((r) => `<option value="${r.id}" ${String(state.filters.assignee_id) === String(r.id) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
        </select>
      </div>
      ` : ''}
      <div>
        <label>Status</label>
        <select id="f-status">
          <option value="">All</option>
          <option value="unassigned">Unassigned</option>
          <option value="assigned">Assigned</option>
          <option value="replied">Replied</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div>
        <label>Automated</label>
        <select id="f-automated">
          <option value="">All</option>
          <option value="false">Not automated</option>
          <option value="true">Automated only</option>
        </select>
      </div>
      <div>
        <label>Tag</label>
        <input id="f-tag" placeholder="e.g. billing" />
      </div>
      <div style="flex:1; min-width:200px;">
        <label>Search</label>
        <input id="f-q" placeholder="subject / from / body" />
      </div>
      <div>
        <label>From date</label>
        <input type="date" id="f-from" value="${escapeHtml(state.filters.from_date)}" />
      </div>
      <div>
        <label>To date</label>
        <input type="date" id="f-to" value="${escapeHtml(state.filters.to_date)}" />
      </div>
    </div>
    <div id="ticket-table-wrap"><em>Loading tickets...</em></div>
  `);

  ['f-mailbox', 'f-assignee', 'f-status', 'f-automated', 'f-from', 'f-to'].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener('change', applyFiltersAndReload);
  });
  let debounce;
  ['f-tag', 'f-q'].forEach((id) => {
    el(id).addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(applyFiltersAndReload, 350);
    });
  });

  await loadTickets();
}

function applyFiltersAndReload() {
  const assigneeNode = el('f-assignee');
  state.filters = {
    mailbox_id: el('f-mailbox').value,
    assignee_id: assigneeNode ? assigneeNode.value : '',
    status: el('f-status').value,
    automated: el('f-automated').value,
    tag: el('f-tag').value,
    q: el('f-q').value,
    from_date: el('f-from').value,
    to_date: el('f-to').value,
  };
  loadTickets();
}

async function loadTickets() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const { tickets } = await api(`/tickets?${params.toString()}`);
  state.tickets = tickets;
  renderTicketTable();
}

function renderTicketTable() {
  const wrap = el('ticket-table-wrap');
  if (!wrap) return;
  if (state.tickets.length === 0) {
    wrap.innerHTML = '<p class="small">No tickets match these filters.</p>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Received</th>
          <th>Mailbox</th>
          <th>From</th>
          <th>Subject</th>
          <th>Assignee</th>
          <th>Status</th>
          <th>TAT</th>
          <th>Tags</th>
        </tr>
      </thead>
      <tbody>
        ${state.tickets.map(rowHtml).join('')}
      </tbody>
    </table>
  `;
  document.querySelectorAll('tr.ticket-row').forEach((tr) => {
    tr.addEventListener('click', () => openTicket(Number(tr.dataset.id)));
  });
}

function tatCell(t) {
  const fr = t.tat && t.tat.first_response && t.tat.first_response.human;
  const res = t.tat && t.tat.resolution && t.tat.resolution.human;
  if (!fr && !res) return '<span class="small">not yet responded</span>';
  return `
    <div class="small">First: ${fr ? escapeHtml(fr) : '—'}</div>
    <div class="small">Resolved: ${res ? escapeHtml(res) : '—'}</div>
  `;
}

function rowHtml(t) {
  return `
    <tr class="ticket-row" data-id="${t.id}">
      <td>${fmtDate(t.received_at)}</td>
      <td>${escapeHtml(t.mailbox_email || '')}</td>
      <td>${escapeHtml(t.from_address || '')}</td>
      <td>${escapeHtml(t.subject || '(no subject)')}
        ${t.is_automated ? '<span class="badge automated">automated</span>' : ''}
      </td>
      <td>${escapeHtml(t.assignee_name || '—')}</td>
      <td><span class="badge ${t.status}">${t.status}</span></td>
      <td>${tatCell(t)}</td>
      <td>${t.tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</td>
    </tr>
  `;
}

// ---------- Ticket detail modal ----------

// Strips common markdown/quote artifacts that some senders' systems leave
// in the plain-text part of an email (literal "**bold**" markers never
// converted to real bold, and "> " blockquote prefixes) - purely cosmetic
// cleanup for display, doesn't touch the stored data.
// Matches the boundary where a message's OWN new text ends and a
// client-embedded copy of the prior message in the thread begins - e.g.
// Gmail's "On <date>, <name> wrote:" top-post marker, or a
// "---------- Forwarded message ---------" block. Because we now store each
// message as its own row (see ticket_messages table comment in db.js), that
// trailing embedded copy is already shown as its own separate bubble earlier
// in the thread - so leaving it in also renders it (and everything below
// it, in a forward chain) makes the same content appear twice in a row.
// This only trims for DISPLAY; the raw body stored in the DB is untouched.
// `[\s\S]` (not `.`) between "On" and "wrote:" is deliberate - Gmail's plain-
// text export hard-wraps long attribution lines (name + date + email
// address can easily exceed a line width), inserting a real newline in the
// middle of "On <date>, <name> wrote:" itself. `.` never matches a newline
// in JS regex, so a wrapped attribution line silently failed to match here,
// letting the entire quoted history through repeatedly (each reply's quote
// growing one message longer) - seen on the disciplinarycommittee@
// mailbox's tickets. `[\s\S]` matches newlines too, closing that gap.
const QUOTE_BOUNDARY_RE = /(^|\n)\s*(On\s[\s\S]{0,160}?wrote:|-{2,}\s*Forwarded message\s*-{2,})/i;

function cleanBodyForDisplay(text) {
  if (!text) return text;
  let body = text;
  const boundary = QUOTE_BOUNDARY_RE.exec(body);
  if (boundary && boundary.index > 0) {
    body = body.slice(0, boundary.index);
  }
  return body
    .split('\n')
    .map((line) => line.replace(/^(\s*>\s?)+/, ''))
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .trim();
}

// Very small allowlist sanitizer for body_html - that column is only ever
// populated by our OWN rich-text reply editor (see openTicket below), never
// from inbound mail, so the input is already fairly trusted, but this
// strips anything that could still execute script (script/style tags,
// on*="" event handler attributes, javascript: URLs) before it's dropped
// into the page as raw HTML.
// Allowlist sanitizer for body_html. Originally this only ever held content
// from our OWN rich-text reply editor (fully trusted), but inbound messages
// now populate it too when the sender's email has a real HTML part (see
// bodyHtml in gmailAdapter.js) - so this strips a bit more than before:
// script/style tags, inline event handler attributes, javascript: URLs, and
// now also iframe/object/embed tags and data: URIs in src, since those can
// come from an external sender we don't control.
function sanitizeRichHtml(html) {
  if (!html) return '';
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*"data:[^"]*"/gi, '$1="#"');
}

// When the same email lands in more than one of our mailboxes at once (see
// pickOwnerMailbox in poller.js), each mailbox's own copy gets its own row
// here - same sender, same content, but a different gmail_message_id/
// to_address per copy. That's correct for the underlying data, but showing
// each copy as its own bubble looks like a plain duplicate. This collapses
// consecutive messages with identical content into a single bubble, noting
// which other mailboxes also received it instead of repeating it.
function dedupeThreadMessages(messages) {
  const result = [];
  for (const m of messages) {
    const cleaned = (m.body_html || cleanBodyForDisplay(m.body) || '').trim();
    const last = result[result.length - 1];
    const lastCleaned = last ? (last.message.body_html || cleanBodyForDisplay(last.message.body) || '').trim() : null;
    if (last && m.direction === last.message.direction && cleaned && cleaned === lastCleaned) {
      const alsoTo = extractEmails(m.to_address)[0];
      if (alsoTo) last.alsoVia.push(alsoTo);
    } else {
      result.push({ message: m, alsoVia: [] });
    }
  }
  return result;
}

// Renders the full per-message conversation thread (see the ticket_messages
// table comment in db.js) as a chat-style list, oldest first. Falls back to
// the old single raw-body display for tickets created before this feature
// shipped (no rows in ticket_messages yet).
// HTML equivalent of cleanBodyForDisplay's QUOTE_BOUNDARY_RE trim, for
// messages that now carry body_html (see gmailAdapter.js's bodyHtml support,
// added so HTML-only senders' real content shows instead of a placeholder
// stub) - without this, the html branch below rendered the ENTIRE raw email
// including Gmail's own embedded quote-history markup, showing the whole
// prior conversation again inside every new reply's bubble (already shown
// separately, and correctly trimmed, in earlier bubbles). Gmail always wraps
// that embedded quote in a `<div class="gmail_quote...">` container
// (containing the "On <date> ... wrote:" attribution + a <blockquote> of
// everything before it), so cutting the HTML at the start of that div drops
// exactly the redundant part and keeps only this message's own new content.
function stripHtmlTagsForCheck(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

// Uses the browser's own HTML parser (via a detached element) rather than a
// raw string cut, and removes the gmail_quote element as a proper DOM node.
// A plain string.slice() at the quote div's start tag looked simpler but was
// a real bug: Gmail nests the quote INSIDE the outer wrapper div of the new
// message (`<div dir="ltr">new text<div class="gmail_quote">...</div></div>`),
// so cutting the string there also chopped off that outer div's closing tag,
// leaving it unclosed. Because the whole ticket modal is inserted as one
// HTML blob, that single unclosed tag swallowed every element after it -
// including the Reply section and the entire sidebar column - into itself,
// which is why the sidebar rendered below the thread instead of beside it
// for tickets whose messages happened to hit this. Parsing into a real DOM
// tree and removing the quote element outright can't leave things unbalanced
// the way string slicing can.
function cleanHtmlForDisplay(html) {
  if (!html) return html;
  try {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    wrapper.querySelectorAll('.gmail_quote, .gmail_quote_container').forEach((node) => node.remove());
    return wrapper.innerHTML;
  } catch {
    return html;
  }
}

function renderThread(messages, ticket) {
  if (!messages || messages.length === 0) {
    return `<div class="body-box">${escapeHtml(cleanBodyForDisplay(ticket.body || ticket.snippet) || '(no body)')}</div>`;
  }
  return `
    <div class="thread">
      ${dedupeThreadMessages(messages).map(({ message: m, alsoVia }) => `
        <div class="thread-message ${m.direction === 'outbound' ? 'outbound' : 'inbound'}">
          <div class="thread-message-meta small">
            <strong>${escapeHtml(m.from_address || (m.direction === 'outbound' ? 'us' : 'them'))}</strong>
            &middot; ${fmtDate(m.sent_at)}
            ${alsoVia.length ? `&middot; also delivered to ${alsoVia.map(escapeHtml).join(', ')}` : ''}
          </div>
          <div class="thread-message-body">${
            (() => {
              if (m.body_html) {
                const trimmed = cleanHtmlForDisplay(m.body_html);
                // If trimming somehow left nothing usable (e.g. the whole
                // message WAS the quote, no new content above it), fall back
                // to the plain-text rendering rather than showing a blank
                // bubble.
                if (trimmed && stripHtmlTagsForCheck(trimmed).trim()) return sanitizeRichHtml(trimmed);
              }
              return escapeHtml(cleanBodyForDisplay(m.body) || '(no body)');
            })()
          }</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function openTicket(id) {
  const { ticket, mailbox_email, events, messages } = await api(`/tickets/${id}`);
  state.openTicketId = id;

  // Only relevant for office-hours-tagged tickets (prefills the reply BODY
  // text below, not who it's sent to - reply-to still just follows the
  // normal sender/thread logic like any other ticket), so don't bother
  // fetching it otherwise.
  let officeHoursTemplate = null;
  if (ticket.tags.includes('office-hours')) {
    try {
      const { value } = await api('/settings/office_hours_template');
      officeHoursTemplate = value;
    } catch {
      // Settings lookup failing shouldn't block opening the ticket - just
      // leave the reply editor empty like normal.
    }
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'ticket-modal';
  backdrop.innerHTML = `
    <div class="modal">
      <button class="close-x">&times;</button>
      <h2>${escapeHtml(ticket.subject || '(no subject)')}
        ${ticket.is_automated ? '<span class="badge automated">automated</span>' : ''}
      </h2>
      <div class="small">From ${escapeHtml(ticket.from_address)} &middot; first received ${fmtDate(ticket.first_received_at || ticket.received_at)}${ticket.received_at && ticket.first_received_at && ticket.received_at !== ticket.first_received_at ? ' &middot; last activity ' + fmtDate(ticket.received_at) : ''} &middot; via ${escapeHtml(mailbox_email || '')}</div>
      ${(() => {
        // Cross-reference every inbound message's To/Cc against our own
        // connected mailboxes (see pickOwnerMailbox in poller.js) so it's
        // obvious at a glance - not just buried in History - when this
        // ticket was actually a broadcast to several of our mailboxes at
        // once, and which ones besides the one it's filed under.
        const ownEmails = new Set((state.mailboxes || []).map((m) => m.email.toLowerCase()));
        const addressed = new Set();
        (messages || [])
          .filter((m) => m.direction === 'inbound')
          .forEach((m) => {
            [...extractEmails(m.to_address), ...extractEmails(m.cc_address)].forEach((e) => {
              if (ownEmails.has(e) && e !== (mailbox_email || '').toLowerCase()) addressed.add(e);
            });
          });
        if (addressed.size === 0) return '';
        return `<div class="info-banner" style="margin-top:8px;">Also addressed to: ${[...addressed].map(escapeHtml).join(', ')}</div>`;
      })()}

      <div class="detail-grid">
        <div>
          <label>${messages && messages.length ? 'Conversation' : 'Body'}</label>
          ${renderThread(messages, ticket)}

          <label>Reply</label>
          <div class="reply-recipients">
            <div class="reply-field"><label>To</label><input id="reply-to" /></div>
            <div class="reply-field"><label>Cc</label><input id="reply-cc" /></div>
            <div class="reply-field"><label>Bcc</label><input id="reply-bcc" /></div>
            <button type="button" class="secondary" id="reply-all-btn">Reply All</button>
          </div>
          <div class="rich-toolbar">
            <button type="button" class="rich-toolbar-btn" data-cmd="bold" title="Bold"><b>B</b></button>
            <button type="button" class="rich-toolbar-btn" data-cmd="italic" title="Italic"><i>I</i></button>
            <button type="button" class="rich-toolbar-btn" data-cmd="underline" title="Underline"><u>U</u></button>
            <button type="button" class="rich-toolbar-btn" data-cmd="insertUnorderedList" title="Bullet list">&bull; List</button>
          </div>
          <div id="reply-body-rich" class="reply-editor" contenteditable="true" data-placeholder="Type your reply..."></div>
          <div class="reply-actions">
            <button id="send-reply-btn">Send reply</button>
            <button class="secondary" id="mark-replied-btn">Mark replied externally</button>
          </div>
          <div id="reply-error"></div>

          ${events.length ? `
            <label style="margin-top:16px;">History</label>
            <ul class="small">
              ${events.map((e) => `<li>${fmtDate(e.created_at)} — ${escapeHtml(e.actor_name || 'system')}: ${escapeHtml(e.event_type)} ${e.detail ? '(' + escapeHtml(e.detail) + ')' : ''}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        <div>
          <div class="side-field">
            <label>Status</label>
            <select id="status-select">
              ${['unassigned', 'assigned', 'replied', 'closed'].map((s) => `<option value="${s}" ${s === ticket.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="side-field">
            <label>Assignee</label>
            ${(() => {
              // Non-admins can assign within a mailbox they've been
              // EXPLICITLY granted on the Team page (see full_access column
              // comment in db.js) - not just because they're unrestricted by
              // default. Mirrors the backend check in PATCH /:id/assign.
              const me = state.roster.find((r) => r.id === state.user.id);
              const canAssign = state.user.is_admin || (me && me.mailbox_ids.includes(ticket.mailbox_id));
              if (!canAssign) {
                return `<div>${escapeHtml((state.roster.find((r) => r.id === ticket.assignee_id) || {}).name || 'Unassigned')} <span class="small">(you need to be granted this mailbox on the Team page to reassign)</span></div>`;
              }
              // Only offer people who could actually see this ticket once
              // assigned: unrestricted (mailbox_ids.length === 0) or
              // explicitly granted this ticket's mailbox. Assigning to
              // someone without access would leave the ticket permanently
              // invisible to its own assignee - the backend already
              // rejects that combination, this just keeps the dropdown from
              // offering it in the first place.
              // Always keep the CURRENT assignee in the list even if they'd
              // no longer be eligible (e.g. their access was revoked after
              // being assigned) - otherwise the dropdown would silently
              // show "Unassigned" as selected while the ticket is still
              // actually assigned to them underneath.
              const eligible = state.roster.filter(
                (r) =>
                  r.id === ticket.assignee_id ||
                  r.mailbox_ids.length === 0 ||
                  r.mailbox_ids.includes(ticket.mailbox_id)
              );
              return `
                <select id="assignee-select">
                  <option value="">Unassigned</option>
                  ${eligible.map((r) => `<option value="${r.id}" ${ticket.assignee_id === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
                </select>
                ${eligible.length < state.roster.length ? '<div class="small" style="margin-top:4px;">Only showing team members with access to this mailbox.</div>' : ''}
              `;
            })()}
          </div>
          <div class="side-field">
            <label>Tags (comma separated)</label>
            <input id="tags-input" value="${escapeHtml(ticket.tags.join(', '))}" />
            <label style="display:inline-flex; align-items:center; gap:6px; margin:8px 0 0 0; font-size:13px; color:var(--text);">
              <input type="checkbox" id="office-hours-tag-checkbox" style="width:auto;" ${ticket.tags.includes('office-hours') ? 'checked' : ''} />
              Office Hours
            </label>
            <button class="secondary" id="save-tags-btn" style="margin-top:6px; display:block;">Save tags</button>
          </div>
          <div class="side-field">
            <label>Automated</label>
            <div>
              <label style="display:inline-flex; align-items:center; gap:6px; margin:0;">
                <input type="checkbox" id="automated-checkbox" style="width:auto;" ${ticket.is_automated ? 'checked' : ''} />
                Flagged as automated (excluded from stats)
              </label>
            </div>
            <div class="small">Source: ${escapeHtml(ticket.automated_source)}${ticket.automated_reason ? ' — ' + escapeHtml(ticket.automated_reason) : ''}</div>
          </div>
          <div class="side-field">
            <label>TAT (turnaround time)</label>
            <div class="stat-row"><span>First response</span><strong>${ticket.tat.first_response.human ? escapeHtml(ticket.tat.first_response.human) : 'not yet responded'}</strong></div>
            <div class="stat-row"><span>Resolution</span><strong>${ticket.tat.resolution.human ? escapeHtml(ticket.tat.resolution.human) : 'not yet resolved'}</strong></div>
          </div>
          ${ticket.last_reply_mode ? `<div class="small">Last reply mode: ${escapeHtml(ticket.last_reply_mode)}</div>` : ''}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.querySelector('.close-x').addEventListener('click', closeTicketModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeTicketModal(); });

  el('status-select').addEventListener('change', async (e) => {
    await api(`/tickets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) });
    await loadTickets();
  });

  if (el('assignee-select')) {
    el('assignee-select').addEventListener('change', async (e) => {
      const assignee_id = e.target.value ? Number(e.target.value) : null;
      await api(`/tickets/${id}/assign`, { method: 'PATCH', body: JSON.stringify({ assignee_id }) });
      await loadTickets();
      closeTicketModal();
      openTicket(id);
    });
  }

  el('save-tags-btn').addEventListener('click', async () => {
    const tags = el('tags-input').value.split(',').map((t) => t.trim()).filter(Boolean);
    if (el('office-hours-tag-checkbox').checked && !tags.includes('office-hours')) tags.push('office-hours');
    if (!el('office-hours-tag-checkbox').checked) {
      const i = tags.indexOf('office-hours');
      if (i !== -1) tags.splice(i, 1);
    }
    await api(`/tickets/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) });
    await loadTickets();
    closeTicketModal();
    openTicket(id);
  });

  // Quick one-click way to file/unfile this ticket under Office Hours
  // without having to type the tag by hand - saves immediately rather than
  // waiting for "Save tags" so toggling it feels instant, same as the other
  // checkboxes on this panel (Automated).
  el('office-hours-tag-checkbox').addEventListener('change', async (e) => {
    const current = el('tags-input').value.split(',').map((t) => t.trim()).filter(Boolean);
    const has = current.includes('office-hours');
    let next = current;
    if (e.target.checked && !has) next = [...current, 'office-hours'];
    else if (!e.target.checked && has) next = current.filter((t) => t !== 'office-hours');
    await api(`/tickets/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags: next }) });
    await loadTickets();
    closeTicketModal();
    openTicket(id);
  });


  el('automated-checkbox').addEventListener('change', async (e) => {
    await api(`/tickets/${id}/automated`, { method: 'PATCH', body: JSON.stringify({ is_automated: e.target.checked }) });
    await loadTickets();
  });

  // Reply defaults to just the original sender, same as before. Reply All
  // pulls in the To/Cc of the LAST inbound message too (see to_address/
  // cc_address on ticket_messages), minus our own mailbox (no point cc-ing
  // ourselves) and minus the sender (already in To, avoid a duplicate).
  // Bcc always starts empty - the original email's own Bcc list is never
  // visible to us (email/Gmail don't disclose it to anyone but the original
  // sender), so there's nothing to prefill there; add one manually if needed.
  const senderEmail = extractEmail(ticket.from_address);
  el('reply-to').value = senderEmail;

  el('reply-all-btn').addEventListener('click', () => {
    const lastInbound = [...(messages || [])].reverse().find((m) => m.direction === 'inbound');
    const ownEmail = (mailbox_email || '').toLowerCase();
    const originalTo = lastInbound ? extractEmails(lastInbound.to_address) : [];
    const originalCc = lastInbound ? extractEmails(lastInbound.cc_address) : [];

    const toSet = [senderEmail, ...originalTo].filter((e) => e && e.toLowerCase() !== ownEmail);
    const to = [...new Set(toSet.map((e) => e.toLowerCase()))];
    const cc = [...new Set(originalCc.filter((e) => e.toLowerCase() !== ownEmail && !to.includes(e.toLowerCase())))];

    el('reply-to').value = to.join(', ');
    el('reply-cc').value = cc.join(', ');
  });

  const richEditor = el('reply-body-rich');
  // Office-hours tickets prefill the reply BODY with the saved template text
  // (see Office Hours tab) - the recipient still follows the normal sender
  // logic above, this only saves re-typing the same boilerplate message each
  // time. Still fully editable before sending, same as if typed by hand.
  if (officeHoursTemplate) {
    richEditor.innerText = officeHoursTemplate;
  }
  document.querySelectorAll('.rich-toolbar-btn').forEach((btn) => {
    // Keep the caret/selection inside the editor - without this, clicking
    // the button first steals focus, and execCommand would have nothing to
    // apply the formatting to.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      richEditor.focus();
      document.execCommand(btn.dataset.cmd, false, null);
    });
  });

  el('send-reply-btn').addEventListener('click', async () => {
    const bodyHtml = richEditor.innerHTML.trim();
    const bodyText = richEditor.innerText.trim();
    if (!bodyText) return;
    try {
      await api(`/tickets/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          bodyText,
          bodyHtml,
          to: el('reply-to').value,
          cc: el('reply-cc').value,
          bcc: el('reply-bcc').value,
        }),
      });
      await loadTickets();
      closeTicketModal();
    } catch (err) {
      el('reply-error').innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });

  el('mark-replied-btn').addEventListener('click', async () => {
    await api(`/tickets/${id}/mark-replied-externally`, { method: 'POST' });
    await loadTickets();
    closeTicketModal();
  });
}

function closeTicketModal() {
  const modal = document.getElementById('ticket-modal');
  if (modal) modal.remove();
  state.openTicketId = null;
}

// ---------- Office Hours tab ----------
// Lists every ticket tagged "office-hours" (set via the picker next to Tags
// in a ticket's detail panel - see openTicket) with its scheduled slot, plus
// a CSV export. Reuses GET /tickets?tag=office-hours so the same
// admin/agent + mailbox-access scoping as the main Tickets page applies
// here automatically - an agent only sees their own office-hours tickets,
// same as anywhere else.
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadOfficeHoursCsv(tickets) {
  const headers = ['Office hours slot', 'Received', 'Mailbox', 'From', 'Subject', 'Assignee', 'Status', 'First response TAT', 'Resolution TAT'];
  const rows = tickets.map((t) => [
    t.office_hours_at ? fmtDate(t.office_hours_at) : '',
    fmtDate(t.first_received_at || t.received_at),
    t.mailbox_email || '',
    t.from_address || '',
    t.subject || '',
    (state.roster.find((r) => r.id === t.assignee_id) || {}).name || 'Unassigned',
    t.status,
    t.tat.first_response.human || '',
    t.tat.resolution.human || '',
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `office-hours-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function renderOfficeHours() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header">
      <h2 style="margin:0;">Office Hours</h2>
      <button class="secondary" id="export-office-hours-btn">Export CSV</button>
    </div>
    <p class="small">Tickets tagged "office-hours".</p>
    <div class="card" style="max-width:480px; margin-bottom:16px; padding:12px 16px;">
      <label style="margin-top:0;">Office hours reply template</label>
      <div class="small" style="margin-bottom:6px;">Prefills the reply message body (not the recipient) when you open an office-hours ticket - still fully editable before sending. Change it here whenever the wording needs to change.</div>
      <textarea id="office-hours-template-input" rows="4" placeholder="e.g. Thanks for reaching out - please pick a slot here: ..."></textarea>
      <button class="secondary" id="save-office-hours-template-btn" style="margin-top:6px;">Save</button>
      <div id="office-hours-template-status" class="small" style="margin-top:6px;"></div>
    </div>
    <div id="office-hours-table-wrap"><em>Loading...</em></div>
  `);

  try {
    const { value } = await api('/settings/office_hours_template');
    if (value) el('office-hours-template-input').value = value;
  } catch {
    // Non-fatal - just leaves the field blank if the lookup fails.
  }
  el('save-office-hours-template-btn').addEventListener('click', async () => {
    const status = el('office-hours-template-status');
    try {
      await api('/settings/office_hours_template', {
        method: 'PUT',
        body: JSON.stringify({ value: el('office-hours-template-input').value }),
      });
      status.textContent = 'Saved.';
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
  });

  const { tickets } = await api('/tickets?tag=office-hours');
  // Soonest-scheduled first; any ticket that's tagged but had its slot
  // cleared (office_hours_at null) sorts to the end instead of erroring.
  tickets.sort((a, b) => {
    if (!a.office_hours_at && !b.office_hours_at) return 0;
    if (!a.office_hours_at) return 1;
    if (!b.office_hours_at) return -1;
    return new Date(a.office_hours_at) - new Date(b.office_hours_at);
  });
  state.officeHoursTickets = tickets;

  const wrap = el('office-hours-table-wrap');
  if (tickets.length === 0) {
    wrap.innerHTML = '<p class="small">No tickets tagged "office-hours" yet.</p>';
  } else {
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Mailbox</th>
            <th>From</th>
            <th>Subject</th>
            <th>Assignee</th>
            <th>Status</th>
            <th>TAT</th>
          </tr>
        </thead>
        <tbody>
          ${tickets.map((t) => `
            <tr class="ticket-row" data-id="${t.id}">
              <td>${escapeHtml(fmtDate(t.first_received_at || t.received_at))}</td>
              <td>${escapeHtml(t.mailbox_email || '')}</td>
              <td>${escapeHtml(t.from_address || '')}</td>
              <td>${escapeHtml(t.subject || '(no subject)')}</td>
              <td>${escapeHtml((state.roster.find((r) => r.id === t.assignee_id) || {}).name || 'Unassigned')}</td>
              <td><span class="badge ${t.status}">${escapeHtml(t.status)}</span></td>
              <td>${escapeHtml(t.tat.first_response.human || '-')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll('.ticket-row').forEach((row) => {
      row.addEventListener('click', () => openTicket(Number(row.dataset.id)));
    });
  }

  el('export-office-hours-btn').addEventListener('click', () => downloadOfficeHoursCsv(state.officeHoursTickets || []));
}

// ---------- Stats / dashboard ----------

// ===================================================================
// Dashboard + person drilldown — for public/app.js
//
// Replaces these three existing functions:
//     renderStats()
//     applyStatsFiltersAndReload()
//     renderStatsData()
// Delete those, paste this block in their place. renderMailboxPicker
// stays as it is.
//
// Also change the statsFilters line near the top of the file to:
//   statsFilters: { preset: 'month', from_date: '', to_date: '', mailbox_ids: null, unit: '#' },
// ===================================================================

// Presets set the range AND the grouping together, so the period table
// never ends up with 400 rows or 1. Ranges are computed client-side; the
// server only ever sees plain from_date/to_date.
const RANGES = {
  today: { label: 'Today', days: 0, group: 'day' },
  week: { label: 'This week', days: 7, group: 'day' },
  month: { label: 'This month', days: 30, group: 'week' },
  quarter: { label: 'This quarter', days: 90, group: 'week' },
  custom: { label: 'Custom', days: null, group: 'week' },
};

// Turnaround targets, in hours. Drive the amber/red dots in the table.
// Move to app_settings when different mailboxes need different numbers.
const FIRST_REPLY_TARGET_H = 24;
const RESOLUTION_TARGET_H = 72;

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function resolvedRange() {
  const f = state.statsFilters;
  if (f.preset === 'custom') {
    return { from: f.from_date, to: f.to_date, group: RANGES.custom.group };
  }
  const r = RANGES[f.preset] || RANGES.month;
  return { from: isoDaysAgo(r.days), to: '', group: r.group };
}

function statsParams() {
  const { from, to } = resolvedRange();
  const p = new URLSearchParams();
  if (from) p.set('from_date', from);
  if (to) p.set('to_date', to);
  // Not a truthiness check: [] is truthy in JS, and an empty selection must
  // still be sent so the server shows zeros instead of silently defaulting.
  if (state.statsFilters.mailbox_ids !== null) {
    p.set('mailboxIds', state.statsFilters.mailbox_ids.join(','));
  }
  return p;
}

function rangeRowHtml(idPrefix) {
  const f = state.statsFilters;
  return `
    <div class="range-row">
      ${Object.entries(RANGES).map(([k, r]) => `
        <button class="range-pill ${f.preset === k ? 'on' : ''}" data-preset="${k}">${r.label}</button>
      `).join('')}
      ${f.preset === 'custom' ? `
        <span class="range-dates">
          <input type="date" id="${idPrefix}-from" value="${escapeHtml(f.from_date)}" />
          <span class="small">to</span>
          <input type="date" id="${idPrefix}-to" value="${escapeHtml(f.to_date)}" />
        </span>` : ''}
      <div id="${idPrefix}-mailboxes" style="position:relative; margin-left:auto;"></div>
    </div>`;
}

function wireRangeRow(idPrefix, reload) {
  document.querySelectorAll(`.range-pill[data-preset]`).forEach((b) => {
    b.addEventListener('click', () => {
      state.statsFilters = { ...state.statsFilters, preset: b.dataset.preset };
      reload();
    });
  });
  const from = el(`${idPrefix}-from`);
  const to = el(`${idPrefix}-to`);
  if (from) from.addEventListener('change', () => {
    state.statsFilters = { ...state.statsFilters, from_date: from.value };
    reload();
  });
  if (to) to.addEventListener('change', () => {
    state.statsFilters = { ...state.statsFilters, to_date: to.value };
    reload();
  });
}

// Two letters beat a photo here: no upload, no maintenance, and it gives the
// eye an anchor per row so scanning eight similar-length names is fast.
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Colour alone must never carry the meaning, so the dot always sits beside a
// value that is itself tinted - two signals, not one.
function tatCell(tat, targetHours) {
  if (!tat || tat.avg_seconds == null) return '<td class="nil">—</td>';
  const hrs = tat.avg_seconds / 3600;
  const cls = hrs >= targetHours ? 'bad' : hrs >= targetHours * 0.6 ? 'warn' : '';
  return `<td class="${cls}"><span class="dot ${cls || 'ok'}"></span>${escapeHtml(tat.avg_human)}</td>`;
}

// ------------------------------------------------------------------ dashboard

async function renderStats() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `<div id="dash-root"><em class="small">Loading…</em></div>`);
  await renderStatsData();
}

async function renderStatsData() {
  const root = el('dash-root');
  const statsQuery = statsParams();

  // The Unassigned queue is defined by CURRENT ownership (assignee_id IS NULL),
  // not by ticket status. Use the same Dashboard date range and mailbox scope
  // when calculating it so the number and the click-through list always match.
  const unassignedCountPromise = (async () => {
    const mailboxIds = state.statsFilters.mailbox_ids;
    if (Array.isArray(mailboxIds) && mailboxIds.length === 0) return 0;

    const makeQuery = (mailboxId) => {
      const p = new URLSearchParams();
      p.set('assignee_id', 'unassigned');
      const { from, to } = resolvedRange();
      if (from) p.set('from_date', from);
      if (to) p.set('to_date', to);
      if (mailboxId != null) p.set('mailbox_id', mailboxId);
      return p;
    };

    if (Array.isArray(mailboxIds)) {
      const results = await Promise.all(mailboxIds.map((id) => api(`/tickets?${makeQuery(id).toString()}`)));
      return results.reduce((sum, r) => sum + (r.tickets || []).length, 0);
    }

    const result = await api(`/tickets?${makeQuery(null).toString()}`);
    return (result.tickets || []).length;
  })();

  const [data, unassignedCount] = await Promise.all([
    api(`/stats?${statsQuery.toString()}`),
    unassignedCountPromise,
  ]);
  data.unassigned = { ...(data.unassigned || {}), total: unassignedCount };

  const unit = state.statsFilters.unit || '#';

  // Row percentages: of THIS person's tickets, how many are in each status.
  // Answers "is this person keeping up". For workload share instead, divide
  // by the team total rather than the row total on the next line.
  const cell = (n, rowTotal) => {
    if (unit === '%' && rowTotal > 0) return `${Math.round((n / rowTotal) * 100)}%`;
    return n;
  };

  const people = data.per_assignee.filter((p) => p.counts.total > 0);
  const maxTotal = people.reduce((m, p) => Math.max(m, p.counts.total), 0);
  const teamTotals = people.reduce((acc, p) => {
    ['assigned', 'replied', 'closed', 'total'].forEach((k) => { acc[k] += p.counts[k]; });
    return acc;
  }, { assigned: 0, replied: 0, closed: 0, total: 0 });

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2 style="margin:0;">Dashboard</h2>
        <p class="meta">${data.total_tickets} tickets · ${data.automated_excluded_total} automated excluded${
          data.mailbox_filter && data.mailbox_filter.excluded.length
            ? ` · excluding ${data.mailbox_filter.excluded.map(escapeHtml).join(', ')}` : ''
        }</p>
      </div>
      <div class="unit-toggle">
        <span class="${unit === '#' ? 'on' : ''}" data-unit="#">#</span>
        <span class="${unit === '%' ? 'on' : ''}" data-unit="%">%</span>
      </div>
    </div>

    ${rangeRowHtml('s')}

    <div class="tiles">
      <div class="tile"><p class="k">Tickets in range</p><p class="v">${teamTotals.total + data.unassigned.total}</p></div>
      <div class="tile"><p class="k">Awaiting first reply</p><p class="v">${teamTotals.assigned + data.unassigned.total}</p></div>
      <div class="tile"><p class="k">1st response</p><p class="v">${
        data.tat.first_response.avg_human || '—'}</p><p class="c">n = ${data.tat.first_response.sample_size}</p></div>
      <div class="tile"><p class="k">Resolution</p><p class="v">${
        data.tat.resolution.avg_human || '—'}</p><p class="c">n = ${data.tat.resolution.sample_size}</p></div>
    </div>

    <div class="dash-card">
      <table class="dash">
        <thead><tr>
          <th>Person</th><th>Assigned</th><th>Replied</th><th>Closed</th>
          <th>Total</th><th>1st response</th><th>Resolution</th>
        </tr></thead>
        <tbody>
          ${people.map((p) => `
            <tr class="link-row" data-member="${p.member.id}">
              <td class="name">
                <span class="who">
                  <span class="avatar">${initials(p.member.name)}</span>
                  <span>${escapeHtml(p.member.name)}</span>
                </span>
              </td>
              <td>${cell(p.counts.assigned, p.counts.total)}</td>
              <td>${cell(p.counts.replied, p.counts.total)}</td>
              <td>${cell(p.counts.closed, p.counts.total)}</td>
              <td class="strong">
                ${p.counts.total}
                <span class="share"><span style="width:${maxTotal ? Math.round((p.counts.total / maxTotal) * 100) : 0}%"></span></span>
              </td>
              ${tatCell(p.tat.first_response, FIRST_REPLY_TARGET_H)}
              ${tatCell(p.tat.resolution, RESOLUTION_TARGET_H)}
            </tr>`).join('')}
          <tr class="queue-row" data-unassigned-queue="1" tabindex="0" role="button" title="Open unassigned tickets for this Dashboard range">
            <td><span class="who"><span class="avatar queue">!</span><span>Unassigned queue</span></span></td>
            <td class="nil">—</td><td class="nil">—</td><td class="nil">—</td>
            <td class="strong">${data.unassigned.total}</td>
            <td class="nil">—</td><td class="nil">—</td>
          </tr>
        </tbody>
        <tfoot><tr>
          <td><span class="who"><span class="avatar blank"></span><span>Team total</span></span></td>
          <td>${cell(teamTotals.assigned, teamTotals.total)}</td>
          <td>${cell(teamTotals.replied, teamTotals.total)}</td>
          <td>${cell(teamTotals.closed, teamTotals.total)}</td>
          <td>${teamTotals.total}</td>
          <td>${data.tat.first_response.avg_human || '—'}</td>
          <td>${data.tat.resolution.avg_human || '—'}</td>
        </tr></tfoot>
      </table>
    </div>
    <p class="small">Click a name for their history.</p>`;

  wireRangeRow('s', renderStatsData);
  root.querySelectorAll('.unit-toggle span[data-unit]').forEach((s) => {
    s.addEventListener('click', () => {
      state.statsFilters = { ...state.statsFilters, unit: s.dataset.unit };
      renderStatsData();
    });
  });
  root.querySelectorAll('tr.link-row[data-member]').forEach((tr) => {
    tr.addEventListener('click', () => renderPerson(parseInt(tr.dataset.member, 10)));
  });

  // Open exactly the tickets represented by the Unassigned queue: current
  // assignee is NULL, regardless of ticket status, using this Dashboard's
  // selected date range.
  const unassignedRow = root.querySelector('tr[data-unassigned-queue]');
  if (unassignedRow) {
    const openUnassignedQueue = () => {
      const { from, to } = resolvedRange();
      const p = new URLSearchParams();
      p.set('assignee_id', 'unassigned');
      if (from) p.set('from_date', from);
      if (to) p.set('to_date', to);
      location.hash = `tickets?${p.toString()}`;
    };
    unassignedRow.addEventListener('click', openUnassignedQueue);
    unassignedRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openUnassignedQueue();
      }
    });
  }

  renderMailboxPicker('s-mailboxes', data.mailbox_filter, (ids) => {
    state.statsFilters = { ...state.statsFilters, mailbox_ids: ids };
    renderStatsData();
  });
}

// ------------------------------------------------------------------ person

async function renderPerson(memberId) {
  state.personId = memberId;
  state.showOverdue = false;
  await renderPersonData();
}

async function renderPersonData() {
  const root = el('dash-root');
  root.innerHTML = '<em class="small">Loading…</em>';
  const { group } = resolvedRange();
  const p = statsParams();
  p.set('group', group);
  const d = await api(`/stats/person/${state.personId}?${p.toString()}`);

  const worse = (mine, avg, lowerIsBetter) => {
    if (mine == null || avg == null) return '';
    return (lowerIsBetter ? mine > avg : mine < avg) ? ' worse' : '';
  };
  const fr = d.totals.first_response.avg_seconds;
  const frAvg = d.team_avg.first_response.avg_seconds;
  const res = d.totals.resolution.avg_seconds;
  const resAvg = d.team_avg.resolution.avg_seconds;
  const bucketLabel = { day: 'Day', week: 'Week of', month: 'Month' }[d.group] || 'Period';

  root.innerHTML = `
    <button class="back-link" id="p-back">← Back to dashboard</button>

    <div class="person-head">
      <span class="avatar lg">${initials(d.member.name)}</span>
      <div>
        <h2 style="margin:0;">${escapeHtml(d.member.name)}</h2>
        <p class="meta">${escapeHtml(d.member.email)} · ${d.totals.open + d.totals.closed} tickets in range</p>
      </div>
    </div>

    ${d.overdue_tickets.length ? `
      <div class="ribbon">
        <span class="msg">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
          </svg>
          ${d.overdue_tickets.length} ticket${d.overdue_tickets.length > 1 ? 's' : ''} open longer than
          ${d.overdue_hours} hours — oldest is ${Math.round(d.overdue_tickets[0].waiting_hours / 24)} days
        </span>
        <button class="link" id="p-toggle">${state.showOverdue ? 'Hide' : 'View them'}</button>
      </div>` : `
      <p class="all-clear">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
        Nothing open beyond ${d.overdue_hours} hours
      </p>`}

    ${state.showOverdue && d.overdue_tickets.length ? `
      <div class="dash-card">
        <table class="dash">
          <thead><tr><th>Subject</th><th>Mailbox</th><th>Status</th><th>Waiting</th></tr></thead>
          <tbody>
            ${d.overdue_tickets.map((t) => `
              <tr class="overdue">
                <td>${escapeHtml(t.subject || '(no subject)')}</td>
                <td>${escapeHtml(t.mailbox.split('@')[0])}</td>
                <td><span class="badge ${t.status}">${t.status}</span></td>
                <td class="alert">${t.waiting_hours >= 48
                  ? `${Math.round(t.waiting_hours / 24)}d` : `${t.waiting_hours}h`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${rangeRowHtml('p')}

    <div class="tiles">
      <div class="tile"><p class="k">Open now</p><p class="v">${d.totals.open}</p>
        <p class="c${worse(d.totals.open, d.team_avg.open, true)}">team avg ${d.team_avg.open}</p></div>
      <div class="tile"><p class="k">Closed</p><p class="v">${d.totals.closed}</p>
        <p class="c">team avg ${d.team_avg.closed}</p></div>
      <div class="tile"><p class="k">1st response</p><p class="v">${d.totals.first_response.avg_human || '—'}</p>
        <p class="c${worse(fr, frAvg, true)}">team avg ${d.team_avg.first_response.avg_human || '—'}</p></div>
      <div class="tile"><p class="k">Resolution</p><p class="v">${d.totals.resolution.avg_human || '—'}</p>
        <p class="c${worse(res, resAvg, true)}">team avg ${d.team_avg.resolution.avg_human || '—'}</p></div>
    </div>

    <div class="dash-card">
      <table class="dash">
        <thead><tr>
          <th>${bucketLabel}</th><th>Received</th><th>Replied</th><th>Closed</th>
          <th>1st response</th><th>Resolution</th>
        </tr></thead>
        <tbody>
          ${d.periods.length ? d.periods.slice().reverse().map((r) => `
            <tr>
              <td>${r.bucket}</td>
              <td>${r.received}</td><td>${r.replied}</td><td>${r.closed}</td>
              <td>${r.first_response_human || '—'}</td>
              <td>${r.resolution_human || '—'}</td>
            </tr>`).join('')
            : `<tr><td colspan="6" class="nil">No tickets in this range.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="dash-card" style="padding:16px;">
      <div class="chart-head">
        <p style="font-size:14px; font-weight:500; margin:0;">Volume and response time</p>
        <span class="chart-legend">
          <span><span style="display:inline-block; width:9px; height:9px; background:var(--brand-line); border-radius:2px; margin-right:5px;"></span>received</span>
          <span><span style="display:inline-block; width:9px; height:2px; background:var(--warn); margin-right:5px; vertical-align:middle;"></span>1st response</span>
        </span>
      </div>
      <div id="p-chart"></div>
    </div>`;

  el('p-back').addEventListener('click', renderStats_reset);
  const tog = el('p-toggle');
  if (tog) tog.addEventListener('click', () => {
    state.showOverdue = !state.showOverdue;
    renderPersonData();
  });
  wireRangeRow('p', renderPersonData);
  renderMailboxPicker('p-mailboxes', d.mailbox_filter, (ids) => {
    state.statsFilters = { ...state.statsFilters, mailbox_ids: ids };
    renderPersonData();
  });
  drawTrend('p-chart', d.periods, d.overdue_hours);
}

function renderStats_reset() {
  state.personId = null;
  renderStatsData();
}

// Hand-rolled SVG rather than Chart.js: two series on one plot with a
// threshold line is less code this way than configuring a chart library,
// and it inherits the theme variables directly.
function drawTrend(containerId, periods, thresholdHours) {
  const box = el(containerId);
  if (!box) return;
  if (!periods.length) { box.innerHTML = '<p class="chart-note">No data in this range.</p>'; return; }

  const W = 620, H = 200, L = 42, R = 14, T = 18, B = 40;
  const plotW = W - L - R, plotH = H - T - B;
  const n = periods.length;
  const step = plotW / n;

  const maxVol = Math.max(...periods.map((p) => p.received), 1);
  const frHours = periods.map((p) =>
    p.first_response_avg_seconds == null ? null : p.first_response_avg_seconds / 3600);
  const maxHrs = Math.max(thresholdHours * 1.15, ...frHours.filter((h) => h != null), 1);

  const barW = Math.min(step * 0.6, 34);
  const cx = (i) => L + step * i + step / 2;
  const volY = (v) => T + plotH - (v / maxVol) * plotH;
  const hrY = (h) => T + plotH - (h / maxHrs) * plotH;

  const pts = frHours.map((h, i) => (h == null ? null : `${cx(i).toFixed(1)},${hrY(h).toFixed(1)}`))
    .filter(Boolean).join(' ');

  const labelEvery = Math.ceil(n / 6);

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:210px;" aria-hidden="true">
      <line x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}" stroke="var(--line)" stroke-width="1"/>
      <line x1="${L}" y1="${T + plotH / 2}" x2="${W - R}" y2="${T + plotH / 2}" stroke="var(--line-soft)" stroke-width="1"/>
      <line x1="${L}" y1="${T}" x2="${W - R}" y2="${T}" stroke="var(--line-soft)" stroke-width="1"/>
      <line x1="${L}" y1="${hrY(thresholdHours).toFixed(1)}" x2="${W - R}" y2="${hrY(thresholdHours).toFixed(1)}"
            stroke="var(--alert)" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="${W - R - 2}" y="${(hrY(thresholdHours) - 4).toFixed(1)}" text-anchor="end"
            font-size="10" fill="var(--alert)">${thresholdHours}h target</text>
      ${periods.map((p, i) => `<rect x="${(cx(i) - barW / 2).toFixed(1)}" y="${volY(p.received).toFixed(1)}"
            width="${barW.toFixed(1)}" height="${(T + plotH - volY(p.received)).toFixed(1)}"
            fill="var(--brand-line)"/>`).join('')}
      ${pts ? `<polyline points="${pts}" fill="none" stroke="var(--warn)" stroke-width="2"/>` : ''}
      ${frHours.map((h, i) => (h == null ? '' :
        `<circle cx="${cx(i).toFixed(1)}" cy="${hrY(h).toFixed(1)}" r="3" fill="var(--warn)"/>`)).join('')}
      <text x="${L - 8}" y="${T + plotH + 4}" text-anchor="end" font-size="10" fill="var(--ink-faint)">0</text>
      <text x="${L - 8}" y="${T + 10}" text-anchor="end" font-size="10" fill="var(--ink-faint)">${maxVol}</text>
      ${periods.map((p, i) => (i % labelEvery === 0
        ? `<text x="${cx(i).toFixed(1)}" y="${H - 16}" text-anchor="middle" font-size="10"
             fill="var(--ink-faint)">${p.bucket.slice(5)}</text>` : '')).join('')}
    </svg>
    <p class="chart-note">Bars are tickets received; the line is average first response.
      Response time rising while volume stays flat is not a load problem.</p>`;
}

// Mailbox filter: a button showing "n of m", opening a dropdown of tick-boxes.
// The server stays the source of truth for what's selected and what the viewer
// is allowed to see - this only renders whatever /api/stats reported back.
const pickerOpen = {};

function closeAllPickers() {
  Object.keys(pickerOpen).forEach((k) => {
    pickerOpen[k] = false;
    const p = document.getElementById(`${k}-pop`);
    if (p) p.style.display = 'none';
  });
}

function renderMailboxPicker(containerId, filter, onChange) {
  const box = el(containerId);
  if (!box || !filter || !filter.options || !filter.options.length) return;
  const opts = filter.options;
  const on = opts.filter((m) => m.selected).length;

  box.innerHTML = `
    <label>Mailboxes</label>
    <div style="position:relative;">
      <button type="button" class="filter-btn ${on < opts.length ? 'active' : ''}" id="${containerId}-btn">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
          <path d="M1.5 2.5h13l-5 6v5l-3-1.5v-3.5z" />
        </svg>
        ${on} of ${opts.length}
      </button>
      <div class="filter-pop" id="${containerId}-pop" style="display:none;">
        <div class="quick"><a data-all="1">Select all</a><a data-none="1">Clear all</a></div>
        ${opts.map((m) => `
          <label class="opt">
            <input type="checkbox" data-mailbox-id="${m.id}" ${m.selected ? 'checked' : ''} />
            <span>${escapeHtml(m.email)}</span>
          </label>`).join('')}
      </div>
    </div>`;

  const btn = el(`${containerId}-btn`);
  const pop = el(`${containerId}-pop`);
  // The whole picker is rebuilt on every reload, so the open/closed state has
  // to be remembered here - otherwise the dropdown snaps shut the moment you
  // tick a box, and you can't untick two things in a row.
  if (pickerOpen[containerId]) pop.style.display = 'block';

  const current = () => Array.from(pop.querySelectorAll('input[data-mailbox-id]'))
    .filter((x) => x.checked)
    .map((x) => parseInt(x.dataset.mailboxId, 10));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = pop.style.display !== 'none';
    closeAllPickers();
    pickerOpen[containerId] = !wasOpen;
    pop.style.display = wasOpen ? 'none' : 'block';
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.querySelectorAll('input[data-mailbox-id]').forEach((cb) => {
    cb.addEventListener('change', () => onChange(current()));
  });
  pop.querySelector('[data-all]').addEventListener('click', () => onChange(opts.map((m) => m.id)));
  pop.querySelector('[data-none]').addEventListener('click', () => onChange([]));

  if (!renderMailboxPicker._wired) {
    renderMailboxPicker._wired = true;
    document.addEventListener('click', closeAllPickers);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllPickers(); });
  }
}

// ---------- My Stats (personal view - available to admins AND agents) ----------

async function renderMyStats() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header">
      <h2 style="margin:0;">My Stats</h2>
    </div>
    <p class="small">Your own tickets only - across whichever mailboxes you've been assigned tickets from.</p>
    <div class="filters">
      <div>
        <label>From date</label>
        <input type="date" id="ms-from" value="${escapeHtml(state.myStatsFilters.from_date)}" />
      </div>
      <div>
        <label>To date</label>
        <input type="date" id="ms-to" value="${escapeHtml(state.myStatsFilters.to_date)}" />
      </div>
      <div style="align-self:flex-end;">
        <button class="secondary" id="ms-clear">Clear dates</button>
      </div>
    </div>
    <div id="mystats-wrap"><em>Loading...</em></div>
  `);

  el('ms-from').addEventListener('change', applyMyStatsFiltersAndReload);
  el('ms-to').addEventListener('change', applyMyStatsFiltersAndReload);
  el('ms-clear').addEventListener('click', () => {
    state.myStatsFilters = { from_date: '', to_date: '' };
    renderMyStatsData();
    el('ms-from').value = '';
    el('ms-to').value = '';
  });

  await renderMyStatsData();
}

function applyMyStatsFiltersAndReload() {
  state.myStatsFilters = {
    from_date: el('ms-from').value,
    to_date: el('ms-to').value,
  };
  renderMyStatsData();
}

async function renderMyStatsData() {
  const params = new URLSearchParams();
  Object.entries(state.myStatsFilters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const data = await api(`/my-stats?${params.toString()}`);
  const wrap = el('mystats-wrap');

  const tatLine = (label, tat) => `
    <div class="stat-row"><span>${escapeHtml(label)}</span><strong>${tat && tat.avg_human ? escapeHtml(tat.avg_human) : '—'}${tat && tat.sample_size ? ` <span class="small">(n=${tat.sample_size})</span>` : ''}</strong></div>
  `;

  wrap.innerHTML = `
    ${data.automated_excluded_total ? `<div class="info-banner">${data.automated_excluded_total} automated ticket(s) assigned to you are excluded from the stats below.</div>` : ''}
    <div class="stats-grid">
      <div class="card stat-card">
        <h3>Overview</h3>
        <div class="stat-row"><span>Unresolved (assigned to you, not yet replied)</span><strong>${data.counts.unresolved}</strong></div>
        <div class="stat-row"><span>Replied</span><strong>${data.counts.replied}</strong></div>
        <div class="stat-row"><span>Closed</span><strong>${data.counts.closed}</strong></div>
        <div class="stat-row"><span>Total</span><strong>${data.counts.total}</strong></div>
      </div>
      <div class="card stat-card">
        <h3>Your TAT (turnaround time)</h3>
        ${tatLine('Avg. first response', data.tat.first_response)}
        ${tatLine('Avg. resolution', data.tat.resolution)}
      </div>
    </div>
    <h3 style="margin-top:24px;">Your tickets per mailbox</h3>
    <table>
      <thead><tr><th>Mailbox</th><th>Unresolved</th><th>Replied</th><th>Closed</th><th>Total</th></tr></thead>
      <tbody>
        ${data.per_mailbox.length ? data.per_mailbox.map((m) => `
          <tr>
            <td>${escapeHtml(m.email)}</td>
            <td>${m.unresolved}</td>
            <td>${m.replied}</td>
            <td>${m.closed}</td>
            <td>${m.total}</td>
          </tr>
        `).join('') : '<tr><td colspan="5" class="small">No tickets assigned to you yet in this range.</td></tr>'}
      </tbody>
    </table>
  `;
}

// ---------- Mailboxes admin ----------

async function renderMailboxes() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header">
      <h2 style="margin:0;">Connected mailboxes</h2>
      <div style="display:flex; gap:8px;">
        <button class="secondary" id="poll-now-btn">Check for new emails now</button>
        <a href="/api/oauth/google/start"><button>+ Connect new mailbox</button></a>
      </div>
    </div>
    <div id="poll-now-status" class="small" style="margin-bottom:8px;"></div>
    <div class="mailbox-list" id="mailbox-list"></div>
    <p class="small">Each mailbox owner should click "Connect new mailbox" themselves and sign in with their own Google account — no password sharing required.</p>
  `);

  el('poll-now-btn').addEventListener('click', async () => {
    const btn = el('poll-now-btn');
    const status = el('poll-now-status');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    status.textContent = '';
    try {
      await api('/mailboxes/poll-now', { method: 'POST' });
      status.textContent = `Done — checked all mailboxes at ${fmtDate(new Date().toISOString())}.`;
      await renderMailboxList();
      if (state.page === 'tickets') await loadTickets();
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check for new emails now';
    }
  });

  await renderMailboxList();
}

// Re-renders just the #mailbox-list element (not the whole page section) -
// used both for the initial load above and after disconnecting a mailbox.
// Calling renderMailboxes() again instead of this would re-append a whole
// second "Connected mailboxes" header/list into #main on top of the
// existing one (since it uses insertAdjacentHTML('beforeend', ...) rather
// than replacing #main's contents), duplicating the section on screen.
async function renderMailboxList() {
  const { mailboxes } = await api('/mailboxes');
  state.mailboxes = mailboxes;
  // Only show "Disconnect" for mailboxes that actually have a live token
  // (m.connected, from the API's !!refresh_token check) - showing it for an
  // already-disconnected mailbox implied there was still something to
  // disconnect, which there isn't; re-connecting is what "+ Connect new
  // mailbox" above is for.
  el('mailbox-list').innerHTML = mailboxes.map((m) => `
    <div class="list-item">
      <div>
        <div>${escapeHtml(m.email)}</div>
        <div class="meta">Status: ${escapeHtml(m.status)} ${m.last_synced_at ? '&middot; last synced ' + fmtDate(m.last_synced_at) : ''}</div>
      </div>
      ${m.connected
        ? `<button class="danger" data-disconnect="${m.id}">Disconnect</button>`
        : `<span class="small">Use "+ Connect new mailbox" above to reconnect</span>`}
    </div>
  `).join('') || '<p class="small">No mailboxes connected yet.</p>';

  document.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Disconnect this mailbox? It will stop being polled until reconnected.')) return;
      await api(`/mailboxes/${btn.dataset.disconnect}`, { method: 'DELETE' });
      renderMailboxList();
    });
  });
}

// ---------- Roster admin ----------

async function renderRoster() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header"><h2 style="margin:0;">Team roster</h2></div>
    <div class="card" style="max-width:420px; margin-bottom:20px;">
      <h3 style="margin-top:0;">Add team member</h3>
      <div id="roster-error"></div>
      <form id="add-member-form">
        <label>Name</label>
        <input id="new-name" required />
        <label>Email</label>
        <input id="new-email" type="email" required />
        <label>Password</label>
        <input id="new-password" type="password" required />
        <div style="margin-top:10px;">
          <label style="display:inline-flex; align-items:center; gap:6px; margin:0;">
            <input type="checkbox" id="new-is-admin" style="width:auto;" />
            Admin (full access: roster, mailboxes, dashboard, all tickets)
          </label>
        </div>
        <p class="small">Leave unchecked for an agent, who will only ever see tickets assigned to them.</p>
        <div style="margin-top:14px;">
          <button type="submit">Add member</button>
        </div>
      </form>
    </div>
    <div class="roster-list" id="roster-list"></div>
  `);

  el('add-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/roster', {
        method: 'POST',
        body: JSON.stringify({
          name: el('new-name').value.trim(),
          email: el('new-email').value.trim(),
          password: el('new-password').value,
          is_admin: el('new-is-admin').checked,
        }),
      });
      await loadShellData();
      renderRosterList();
      el('add-member-form').reset();
    } catch (err) {
      el('roster-error').innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });

  renderRosterList();
}

function renderRosterList() {
  el('roster-list').innerHTML = state.roster.map((m) => `
    <div class="list-item">
      <div>
        <div>${escapeHtml(m.name)} ${m.is_admin ? '<span class="small">(admin)</span>' : ''}</div>
        <div class="meta">${escapeHtml(m.email)}${m.mailbox_ids && m.mailbox_ids.length ? ` &middot; restricted to ${m.mailbox_ids.length} mailbox${m.mailbox_ids.length === 1 ? '' : 'es'}` : ''}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="secondary" data-edit="${m.id}">Edit</button>
        <button class="danger" data-remove="${m.id}" ${m.id === state.user.id ? 'disabled title="Cannot remove yourself"' : ''}>Remove</button>
      </div>
    </div>
  `).join('') || '<p class="small">No team members yet.</p>';

  document.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this team member? Their assigned tickets will become unassigned.')) return;
      await api(`/roster/${btn.dataset.remove}`, { method: 'DELETE' });
      await loadShellData();
      renderRosterList();
    });
  });

  document.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditMember(Number(btn.dataset.edit)));
  });
}

function openEditMember(id) {
  const member = state.roster.find((m) => m.id === id);
  if (!member) return;
  const isAdmin = state.user.is_admin;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'edit-member-modal';
  backdrop.innerHTML = `
    <div class="modal" style="max-width:420px;">
      <button class="close-x">&times;</button>
      <h2>Edit team member</h2>
      <div id="edit-member-error"></div>
      <form id="edit-member-form">
        <label>Name</label>
        <input id="edit-name" value="${escapeHtml(member.name)}" required />
        <label>Email</label>
        <input id="edit-email" type="email" value="${escapeHtml(member.email)}" ${isAdmin ? '' : 'disabled'} />
        <label>New password (leave blank to keep current)</label>
        <input id="edit-password" type="password" placeholder="••••••••" />
        ${isAdmin ? `
        <div style="margin-top:10px;">
          <label style="display:inline-flex; align-items:center; gap:6px; margin:0;">
            <input type="checkbox" id="edit-is-admin" style="width:auto;" ${member.is_admin ? 'checked' : ''} ${member.id === state.user.id ? 'disabled title="Cannot remove your own admin access"' : ''} />
            Admin (full access)
          </label>
        </div>
        <hr style="margin:14px 0; border:none; border-top:1px solid #e5e7eb;" />
        <label style="display:inline-flex; align-items:center; gap:6px; margin:0;">
          <input type="checkbox" id="edit-restrict-mailboxes" style="width:auto;" ${member.mailbox_ids.length ? 'checked' : ''} />
          Restrict to specific mailboxes
        </label>
        <p class="small" style="margin-top:4px;">Off = sees every mailbox (default). Applies to admins and agents alike - even an admin only sees tickets from the mailboxes checked below once this is turned on.</p>
        <div id="mailbox-access-list" style="display:${member.mailbox_ids.length ? 'block' : 'none'}; margin-top:8px;">
          ${state.mailboxes.map((m) => `
            <div style="display:flex; align-items:center; gap:14px; margin:4px 0;">
              <label style="display:flex; align-items:center; gap:6px; margin:0;">
                <input type="checkbox" class="mailbox-access-checkbox" value="${m.id}" style="width:auto;" ${member.mailbox_ids.includes(m.id) ? 'checked' : ''} />
                ${escapeHtml(m.email)}
              </label>
              <label style="display:flex; align-items:center; gap:6px; margin:0; color:var(--muted); font-size:12px;">
                <input type="checkbox" class="mailbox-full-access-checkbox" value="${m.id}" style="width:auto;" ${(member.full_access_mailbox_ids || []).includes(m.id) ? 'checked' : ''} ${member.mailbox_ids.includes(m.id) ? '' : 'disabled'} />
                Full access (see all tickets, not just assigned)
              </label>
            </div>
          `).join('') || '<p class="small">No mailboxes connected yet.</p>'}
        </div>
        ` : ''}
        <div style="margin-top:14px;">
          <button type="submit">Save changes</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector('.close-x').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  if (isAdmin) {
    el('edit-restrict-mailboxes').addEventListener('change', (e) => {
      el('mailbox-access-list').style.display = e.target.checked ? 'block' : 'none';
    });
    // Full-access only makes sense for a mailbox that's actually checked -
    // keep its checkbox disabled (and unchecked) otherwise.
    document.querySelectorAll('.mailbox-access-checkbox').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const fullAccessBox = document.querySelector(`.mailbox-full-access-checkbox[value="${e.target.value}"]`);
        if (!fullAccessBox) return;
        fullAccessBox.disabled = !e.target.checked;
        if (!e.target.checked) fullAccessBox.checked = false;
      });
    });
  }

  el('edit-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: el('edit-name').value.trim() };
    if (isAdmin) {
      body.email = el('edit-email').value.trim();
      body.is_admin = el('edit-is-admin').checked;
    }
    const password = el('edit-password').value;
    if (password) body.password = password;

    if (isAdmin) {
      const restrict = el('edit-restrict-mailboxes').checked;
      const checked = Array.from(document.querySelectorAll('.mailbox-access-checkbox:checked')).map((c) => Number(c.value));
      if (restrict && checked.length === 0) {
        el('edit-member-error').innerHTML = `<div class="error-banner">Check at least one mailbox, or turn off "Restrict to specific mailboxes" for unrestricted access.</div>`;
        return;
      }
    }

    try {
      await api(`/roster/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (isAdmin) {
        const restrict = el('edit-restrict-mailboxes').checked;
        const mailbox_ids = restrict
          ? Array.from(document.querySelectorAll('.mailbox-access-checkbox:checked')).map((c) => Number(c.value))
          : [];
        const full_access_mailbox_ids = restrict
          ? Array.from(document.querySelectorAll('.mailbox-full-access-checkbox:checked')).map((c) => Number(c.value))
          : [];
        await api(`/roster/${id}/mailbox-access`, {
          method: 'PUT',
          body: JSON.stringify({ mailbox_ids, full_access_mailbox_ids }),
        });
      }
      await loadShellData();
      backdrop.remove();
      if (id === state.user.id) {
        const { user } = await api('/auth/me');
        state.user = user;
        renderApp(); // refreshes the topbar name/nav (e.g. if admin status changed)
      } else if (el('roster-list')) {
        renderRosterList();
      }
    } catch (err) {
      el('edit-member-error').innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
}

initTheme();
boot();
