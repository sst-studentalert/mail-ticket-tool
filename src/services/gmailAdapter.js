// Gmail implementation of the mailboxProvider interface (see mailboxProvider.js).
// Uses the Gmail API (googleapis) with a per-mailbox OAuth2 refresh token -
// no IMAP, no shared passwords, minimal scopes (readonly + send).
const { google } = require('googleapis');
const config = require('../config');
const db = require('../db');

function newOAuthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri
  );
}

function getAuthUrl(state) {
  const oauth2Client = newOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // force showing the consent screen every time so we reliably get a
    // refresh_token back even if the user connected before and revoked it.
    prompt: 'consent',
    scope: config.gmailScopes,
    state,
  });
}

async function handleOAuthCallback(code) {
  const oauth2Client = newOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
  const { data } = await oauth2.userinfo.get();

  return {
    email: data.email,
    refreshToken: tokens.refresh_token || null,
    accessToken: tokens.access_token || null,
    expiryDate: tokens.expiry_date || null,
  };
}

// Builds an authenticated Gmail client for a given mailbox row, refreshing
// the access token from the stored refresh_token as needed. googleapis
// handles the actual refresh automatically once credentials are set.
function clientFor(mailboxRow) {
  const oauth2Client = newOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: mailboxRow.refresh_token,
    access_token: mailboxRow.access_token || undefined,
    expiry_date: mailboxRow.token_expiry || undefined,
  });

  // Persist refreshed access tokens so we don't hammer the token endpoint
  // needlessly and so the stored row stays useful for debugging.
  oauth2Client.on('tokens', (tokens) => {
    const fields = [];
    const values = [];
    if (tokens.access_token) {
      fields.push('access_token = ?');
      values.push(tokens.access_token);
    }
    if (tokens.expiry_date) {
      fields.push('token_expiry = ?');
      values.push(tokens.expiry_date);
    }
    if (fields.length) {
      values.push(mailboxRow.id);
      // Fire-and-forget: this runs inside an event callback (not awaited by
      // its caller), so just log if it fails rather than throwing into an
      // unhandled promise rejection.
      db.prepare(`UPDATE mailboxes SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...values)
        .catch((err) => console.error('[gmailAdapter] Failed to persist refreshed token:', err));
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function headerValue(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function headersMap(headers) {
  const map = {};
  for (const h of headers || []) {
    map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

// Recursively walk a Gmail message payload to find the best plain-text body.
// Falls back to stripping HTML tags if only text/html is present.
function extractBody(payload) {
  if (!payload) return '';

  const decode = (data) => Buffer.from(data, 'base64').toString('utf8');

  function walk(part) {
    if (!part) return { text: '', html: '' };
    let text = '';
    let html = '';

    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      text = decode(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html = decode(part.body.data);
    }

    if (part.parts) {
      for (const sub of part.parts) {
        const r = walk(sub);
        text = text || r.text;
        html = html || r.html;
      }
    }
    return { text, html };
  }

  const { text, html } = walk(payload);
  if (text) return text.trim();
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function normalizeMessage(gmailMessage) {
  const headers = gmailMessage.payload ? gmailMessage.payload.headers : [];
  const from = headerValue(headers, 'From');
  const subject = headerValue(headers, 'Subject');
  const messageIdHeader = headerValue(headers, 'Message-Id') || headerValue(headers, 'Message-ID');
  const dateHeader = headerValue(headers, 'Date');
  const internalDateMs = parseInt(gmailMessage.internalDate || '0', 10);

  return {
    providerMessageId: gmailMessage.id,
    providerThreadId: gmailMessage.threadId,
    messageIdHeader,
    from,
    subject,
    snippet: gmailMessage.snippet || '',
    bodyText: extractBody(gmailMessage.payload),
    receivedAt: internalDateMs
      ? new Date(internalDateMs).toISOString()
      : dateHeader
      ? new Date(dateHeader).toISOString()
      : new Date().toISOString(),
    internalDate: gmailMessage.internalDate,
    headers: headersMap(headers),
  };
}

async function getMessage(mailboxRow, providerMessageId) {
  const gmail = clientFor(mailboxRow);
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: providerMessageId,
    format: 'full',
  });
  return normalizeMessage(data);
}

// Lists new INBOX messages since the mailbox's last checkpoint. We use
// last_internal_date (simplest, robust) rather than Gmail's historyId
// mechanism, because historyId expires after ~7 days of inactivity and would
// require extra recovery logic; a simple "after:" query on internalDate is
// resilient even if the poller is down for a while.
async function listNewMessages(mailboxRow) {
  const gmail = clientFor(mailboxRow);

  let q = 'in:inbox';
  if (mailboxRow.last_internal_date) {
    // Gmail search "after:" is date-only (day granularity), so we also
    // filter precisely by internalDate after fetching, to avoid re-creating
    // tickets for messages already seen earlier the same day.
    const afterDate = new Date(parseInt(mailboxRow.last_internal_date, 10));
    const y = afterDate.getUTCFullYear();
    const m = String(afterDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(afterDate.getUTCDate()).padStart(2, '0');
    q += ` after:${y}/${m}/${d}`;
  }

  // TEMPORARY DEBUG LOGGING - remove once the missing-message issue is
  // diagnosed. Prints the exact Gmail search query and raw/filtered counts
  // so we can tell whether Gmail's API isn't returning a candidate message
  // at all, vs. it being fetched and then discarded by our date filter.
  console.log(`[gmailAdapter] listNewMessages(${mailboxRow.email}): q="${q}" last_internal_date=${mailboxRow.last_internal_date}`);

  const results = [];
  let pageToken;
  let rawCount = 0;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 50,
      pageToken,
    });
    if (data.messages) {
      rawCount += data.messages.length;
      for (const m of data.messages) {
        const full = await getMessage(mailboxRow, m.id);
        const internalDateMs = parseInt(full.internalDate || '0', 10);
        const lastSeenMs = parseInt(mailboxRow.last_internal_date || '0', 10);
        console.log(
          `[gmailAdapter]   candidate ${m.id} subject="${full.subject}" internalDate=${internalDateMs} (${new Date(internalDateMs).toISOString()}) lastSeenMs=${lastSeenMs} -> ${internalDateMs > lastSeenMs ? 'INCLUDED' : 'excluded (not newer than checkpoint)'}`
        );
        if (internalDateMs > lastSeenMs) {
          results.push(full);
        }
      }
    }
    pageToken = data.nextPageToken;
    // Safety cap: don't loop forever on a mailbox with huge backlog on first sync.
  } while (pageToken && results.length < 200);

  console.log(`[gmailAdapter] listNewMessages(${mailboxRow.email}): Gmail returned ${rawCount} raw candidate(s), ${results.length} passed the checkpoint filter`);

  // Oldest first, so tickets are created in chronological order.
  results.sort((a, b) => parseInt(a.internalDate, 10) - parseInt(b.internalDate, 10));
  return results;
}

// Lists new messages in the mailbox's SENT folder since the last checkpoint
// (mirrors listNewMessages, but for outgoing mail). Used to auto-detect
// replies sent directly from the user's own mail client instead of through
// this tool - see services/poller.js.
async function listSentMessages(mailboxRow) {
  const gmail = clientFor(mailboxRow);

  let q = 'in:sent';
  if (mailboxRow.last_sent_internal_date) {
    const afterDate = new Date(parseInt(mailboxRow.last_sent_internal_date, 10));
    const y = afterDate.getUTCFullYear();
    const m = String(afterDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(afterDate.getUTCDate()).padStart(2, '0');
    q += ` after:${y}/${m}/${d}`;
  }

  // TEMPORARY DEBUG LOGGING - remove once the missing-message issue is
  // diagnosed (see the matching block in listNewMessages above).
  console.log(`[gmailAdapter] listSentMessages(${mailboxRow.email}): q="${q}" last_sent_internal_date=${mailboxRow.last_sent_internal_date}`);

  const results = [];
  let pageToken;
  let rawCount = 0;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 50,
      pageToken,
    });
    if (data.messages) {
      rawCount += data.messages.length;
      for (const m of data.messages) {
        const full = await getMessage(mailboxRow, m.id);
        const internalDateMs = parseInt(full.internalDate || '0', 10);
        const lastSeenMs = parseInt(mailboxRow.last_sent_internal_date || '0', 10);
        console.log(
          `[gmailAdapter]   sent candidate ${m.id} subject="${full.subject}" internalDate=${internalDateMs} (${new Date(internalDateMs).toISOString()}) lastSeenMs=${lastSeenMs} -> ${internalDateMs > lastSeenMs ? 'INCLUDED' : 'excluded (not newer than checkpoint)'}`
        );
        if (internalDateMs > lastSeenMs) {
          results.push(full);
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken && results.length < 200);

  console.log(`[gmailAdapter] listSentMessages(${mailboxRow.email}): Gmail returned ${rawCount} raw candidate(s), ${results.length} passed the checkpoint filter`);

  results.sort((a, b) => parseInt(a.internalDate, 10) - parseInt(b.internalDate, 10));
  return results;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeHeaderIfNeeded(value) {
  // Minimal RFC 2047 handling for non-ASCII subjects.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Sends a reply, threaded via In-Reply-To/References + Gmail's threadId.
async function sendReply(mailboxRow, { threadId, messageIdHeader, to, subject, bodyText }) {
  const gmail = clientFor(mailboxRow);

  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || ''}`;
  const lines = [
    `From: ${mailboxRow.email}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderIfNeeded(replySubject)}`,
  ];
  if (messageIdHeader) {
    lines.push(`In-Reply-To: ${messageIdHeader}`);
    lines.push(`References: ${messageIdHeader}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('');
  lines.push(bodyText || '');

  const raw = base64url(lines.join('\r\n'));

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId, // keeps it in the same Gmail thread
    },
  });

  return { id: data.id, threadId: data.threadId };
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  listNewMessages,
  listSentMessages,
  getMessage,
  sendReply,
};
