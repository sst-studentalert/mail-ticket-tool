// Plain vanilla-JS single-page app. No build step, no framework - just
// fetch() against the REST API and manual DOM rendering. Keep it this way;
// the goal is that anyone comfortable with basic JS can read and modify it.

const state = {
  user: null,
  mailboxes: [],
  roster: [],
  tickets: [],
  filters: { mailbox_id: '', assignee_id: '', status: '', automated: '', tag: '', q: '', from_date: '', to_date: '' },
  statsFilters: { from_date: '', to_date: '' },
  myStatsFilters: { from_date: '', to_date: '' },
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
  // Agents (non-admins) only ever get the Tickets page - the other pages'
  // APIs would 403 for them anyway, so don't even render them.
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

function renderApp() {
  const app = document.getElementById('app');
  const nav = [
    ['tickets', 'Tickets'],
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

  const params = new URLSearchParams(location.search);
  const banner = [];
  if (params.get('mailbox_connected')) banner.push('<div class="info-banner">Mailbox connected successfully.</div>');
  if (params.get('mailbox_error')) banner.push(`<div class="error-banner">Mailbox connection failed: ${escapeHtml(params.get('mailbox_error'))}</div>`);

  const mainHtml = banner.join('');
  el('main').innerHTML = mainHtml;

  if (state.page === 'stats') renderStats();
  else if (state.page === 'mystats') renderMyStats();
  else if (state.page === 'mailboxes') renderMailboxes();
  else if (state.page === 'roster') renderRoster();
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

// ---------- Tickets list ----------

async function renderTickets() {
  const main = el('main');
  const isAdmin = state.user.is_admin;
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
          <option value="unassigned">Unassigned</option>
          ${state.roster.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
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
        <input type="date" id="f-from" />
      </div>
      <div>
        <label>To date</label>
        <input type="date" id="f-to" />
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

async function openTicket(id) {
  const { ticket, mailbox_email, events } = await api(`/tickets/${id}`);
  state.openTicketId = id;

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

      <div class="detail-grid">
        <div>
          <label>Body</label>
          <div class="body-box">${escapeHtml(ticket.body || ticket.snippet || '(no body)')}</div>

          <label>Reply</label>
          <textarea id="reply-body" rows="6" placeholder="Type your reply..."></textarea>
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
            ${state.user.is_admin ? `
            <select id="assignee-select">
              <option value="">Unassigned</option>
              ${state.roster.map((r) => `<option value="${r.id}" ${ticket.assignee_id === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
            </select>
            ` : `<div>${escapeHtml((state.roster.find((r) => r.id === ticket.assignee_id) || {}).name || 'Unassigned')} <span class="small">(only an admin can reassign)</span></div>`}
          </div>
          <div class="side-field">
            <label>Tags (comma separated)</label>
            <input id="tags-input" value="${escapeHtml(ticket.tags.join(', '))}" />
            <button class="secondary" id="save-tags-btn" style="margin-top:6px;">Save tags</button>
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
    await api(`/tickets/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) });
    await loadTickets();
  });

  el('automated-checkbox').addEventListener('change', async (e) => {
    await api(`/tickets/${id}/automated`, { method: 'PATCH', body: JSON.stringify({ is_automated: e.target.checked }) });
    await loadTickets();
  });

  el('send-reply-btn').addEventListener('click', async () => {
    const body = el('reply-body').value;
    if (!body.trim()) return;
    try {
      await api(`/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
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

// ---------- Stats / dashboard ----------

async function renderStats() {
  const main = el('main');
  main.insertAdjacentHTML('beforeend', `
    <div class="section-header">
      <h2 style="margin:0;">Dashboard</h2>
    </div>
    <div class="filters">
      <div>
        <label>From date</label>
        <input type="date" id="s-from" value="${escapeHtml(state.statsFilters.from_date)}" />
      </div>
      <div>
        <label>To date</label>
        <input type="date" id="s-to" value="${escapeHtml(state.statsFilters.to_date)}" />
      </div>
      <div style="align-self:flex-end;">
        <button class="secondary" id="s-clear">Clear dates</button>
      </div>
    </div>
    <div id="stats-wrap"><em>Loading...</em></div>
  `);

  el('s-from').addEventListener('change', applyStatsFiltersAndReload);
  el('s-to').addEventListener('change', applyStatsFiltersAndReload);
  el('s-clear').addEventListener('click', () => {
    state.statsFilters = { from_date: '', to_date: '' };
    renderStatsData();
    el('s-from').value = '';
    el('s-to').value = '';
  });

  await renderStatsData();
}

function applyStatsFiltersAndReload() {
  state.statsFilters = {
    from_date: el('s-from').value,
    to_date: el('s-to').value,
  };
  renderStatsData();
}

async function renderStatsData() {
  const params = new URLSearchParams();
  Object.entries(state.statsFilters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const data = await api(`/stats?${params.toString()}`);
  const wrap = el('stats-wrap');

  const tatLine = (label, tat) => `
    <div class="stat-row"><span>${escapeHtml(label)}</span><strong>${tat && tat.avg_human ? escapeHtml(tat.avg_human) : '—'}${tat && tat.sample_size ? ` <span class="small">(n=${tat.sample_size})</span>` : ''}</strong></div>
  `;

  const cardHtml = (title, counts, tat) => `
    <div class="card stat-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="stat-row"><span>Unassigned</span><strong>${counts.unassigned}</strong></div>
      <div class="stat-row"><span>Assigned</span><strong>${counts.assigned}</strong></div>
      <div class="stat-row"><span>Replied</span><strong>${counts.replied}</strong></div>
      <div class="stat-row"><span>Closed</span><strong>${counts.closed}</strong></div>
      <div class="stat-row"><span>Total</span><strong>${counts.total}</strong></div>
      ${tat ? `
        <hr style="margin:8px 0; border:none; border-top:1px solid #e5e7eb;" />
        ${tatLine('Avg. first response', tat.first_response)}
        ${tatLine('Avg. resolution', tat.resolution)}
      ` : ''}
    </div>
  `;

  wrap.innerHTML = `
    <div class="info-banner">
      Total tickets: ${data.total_tickets} &middot; Automated (excluded from stats below): ${data.automated_excluded_total}
    </div>
    <div class="card stat-card" style="max-width:420px; margin-bottom:16px;">
      <h3>Team-wide TAT (turnaround time)</h3>
      ${tatLine('Avg. first response', data.tat.first_response)}
      ${tatLine('Avg. resolution', data.tat.resolution)}
      <p class="small" style="margin-top:8px;">First response = time to first assignment or reply. Resolution = time to closed (or replied, if never explicitly closed). Automated tickets excluded from both.</p>
    </div>
    <div class="charts-grid">
      <div class="card chart-card">
        <h3>TAT by person</h3>
        <canvas id="chart-tat-by-person" height="220"></canvas>
      </div>
      <div class="card chart-card">
        <h3>TAT over time</h3>
        <canvas id="chart-tat-trend" height="220"></canvas>
      </div>
    </div>
    <div class="stats-grid">
      ${cardHtml('Unassigned bucket', data.unassigned)}
      ${data.per_assignee.map((p) => cardHtml(p.member.name, p.counts, p.tat)).join('')}
    </div>
    <h3 style="margin-top:24px;">Tickets per mailbox (non-automated)</h3>
    <table>
      <thead><tr><th>Mailbox</th><th>Count</th></tr></thead>
      <tbody>
        ${data.per_mailbox.map((m) => `<tr><td>${escapeHtml(m.email)}</td><td>${m.c}</td></tr>`).join('')}
      </tbody>
    </table>
  `;

  renderTatCharts(data);
}

// Destroy-and-recreate on every reload (simplest way to keep Chart.js in
// sync with filter changes without tracking dirty state).
let tatByPersonChart = null;
let tatTrendChart = null;

function renderTatCharts(data) {
  if (typeof Chart === 'undefined') {
    // CDN script (loaded in index.html) didn't load - surface this visibly
    // instead of leaving two blank boxes with no explanation, so it's
    // obvious to whoever's looking whether this is a real bug or just a
    // blocked/offline CDN.
    ['chart-tat-by-person', 'chart-tat-trend'].forEach((id) => {
      const canvas = document.getElementById(id);
      if (canvas) {
        canvas.replaceWith(Object.assign(document.createElement('p'), {
          className: 'small',
          textContent: 'Charts unavailable - the Chart.js library failed to load (check your network/CDN access).',
        }));
      }
    });
    return;
  }

  // Rounding to 1 decimal place made anything under ~3 minutes collapse to
  // 0.0 (invisible bar) - 3 decimals keeps small/test-data TATs visible
  // while still reading cleanly for real multi-hour TATs.
  const hours = (seconds) => (seconds == null ? null : Math.round((seconds / 3600) * 1000) / 1000);

  // --- Chart 1: TAT by person (grouped bar, first response vs resolution) ---
  const peopleLabels = data.per_assignee.map((p) => p.member.name);
  const frByPerson = data.per_assignee.map((p) => hours(p.tat.first_response.avg_seconds));
  const resByPerson = data.per_assignee.map((p) => hours(p.tat.resolution.avg_seconds));

  const byPersonCtx = document.getElementById('chart-tat-by-person');
  if (tatByPersonChart) tatByPersonChart.destroy();
  if (byPersonCtx && peopleLabels.length) {
    tatByPersonChart = new Chart(byPersonCtx, {
      type: 'bar',
      data: {
        labels: peopleLabels,
        datasets: [
          { label: 'Avg. first response (hrs)', data: frByPerson, backgroundColor: '#4f83cc' },
          { label: 'Avg. resolution (hrs)', data: resByPerson, backgroundColor: '#7fb069' },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Hours' } } },
        plugins: { legend: { position: 'bottom' } },
      },
    });
  } else if (byPersonCtx) {
    byPersonCtx.replaceWith(Object.assign(document.createElement('p'), { className: 'small', textContent: 'No team members yet.' }));
  }

  // --- Chart 2: TAT over time (line, one point per day) ---
  const trend = data.tat_trend || [];
  const trendCtx = document.getElementById('chart-tat-trend');
  if (tatTrendChart) tatTrendChart.destroy();
  if (trendCtx && trend.length) {
    tatTrendChart = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.day),
        datasets: [
          {
            label: 'Avg. first response (hrs)',
            data: trend.map((t) => hours(t.first_response_avg_seconds)),
            borderColor: '#4f83cc',
            backgroundColor: '#4f83cc',
            tension: 0.25,
            spanGaps: true,
          },
          {
            label: 'Avg. resolution (hrs)',
            data: trend.map((t) => hours(t.resolution_avg_seconds)),
            borderColor: '#7fb069',
            backgroundColor: '#7fb069',
            tension: 0.25,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Hours' } } },
        plugins: { legend: { position: 'bottom' } },
      },
    });
  } else if (trendCtx) {
    trendCtx.replaceWith(Object.assign(document.createElement('p'), { className: 'small', textContent: 'No ticket activity in this range yet.' }));
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
      <a href="/api/oauth/google/start"><button>+ Connect new mailbox</button></a>
    </div>
    <div class="mailbox-list" id="mailbox-list"></div>
    <p class="small">Each mailbox owner should click "Connect new mailbox" themselves and sign in with their own Google account — no password sharing required.</p>
  `);

  const { mailboxes } = await api('/mailboxes');
  state.mailboxes = mailboxes;
  el('mailbox-list').innerHTML = mailboxes.map((m) => `
    <div class="list-item">
      <div>
        <div>${escapeHtml(m.email)}</div>
        <div class="meta">Status: ${escapeHtml(m.status)} ${m.last_synced_at ? '&middot; last synced ' + fmtDate(m.last_synced_at) : ''}</div>
      </div>
      <button class="danger" data-disconnect="${m.id}">Disconnect</button>
    </div>
  `).join('') || '<p class="small">No mailboxes connected yet.</p>';

  document.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Disconnect this mailbox? It will stop being polled until reconnected.')) return;
      await api(`/mailboxes/${btn.dataset.disconnect}`, { method: 'DELETE' });
      renderMailboxes();
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
        <div class="meta">${escapeHtml(m.email)}</div>
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

  el('edit-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: el('edit-name').value.trim() };
    if (isAdmin) {
      body.email = el('edit-email').value.trim();
      body.is_admin = el('edit-is-admin').checked;
    }
    const password = el('edit-password').value;
    if (password) body.password = password;

    try {
      await api(`/roster/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
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

boot();
