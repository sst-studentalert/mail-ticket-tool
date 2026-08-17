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

// Recursively walk a Gmail message payload and pull out both the text/plain
// and text/html parts (whichever exist) - unlike the old version of this
// function, we now keep both rather than discarding the html once a plain-
// text part is found, because some senders' plain-text part is just a
// one-line stub like "Please view this email in HTML format." even though
// the REAL content only exists as HTML (common with corporate mailer
// templates, e.g. the Disciplinary Committee's pink-slip emails). Blindly
// preferring text/plain whenever it's non-empty was storing that stub as the
// entire message body.
function extractBodyParts(payload) {
  if (!payload) return { text: '', html: '' };

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
  return { text: text.trim(), html: html.trim() };
}

function stripHtmlTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Matches the handful of common "this email is HTML-only" stub phrases some
// mail templates put in the plain-text part instead of real content (e.g.
// "Please view this email in HTML format.", "View this message in a web
// browser"). When the plain-text part is JUST one of these (nothing else),
// treat it as if there were no useful plain text at all and fall back to the
// html part instead.
const PLACEHOLDER_TEXT_RE = /^(please )?view (this|the) (e-?mail|message)( in (html( format)?|(a |your )?(web )?browser))?\.?$/i;

// Picks the best available plain-text rendering of a message: the real
// text/plain part, unless it's one of the known placeholder stubs above, in
// which case the html part (tags stripped) is used instead. Falls back to
// the placeholder text itself if there's no html to fall back to.
function bestPlainText(text, html) {
  if (text && !PLACEHOLDER_TEXT_RE.test(text)) return text;
  if (html) return stripHtmlTags(html);
  return text;
}

function normalizeMessage(gmailMessage) {
  const headers = gmailMessage.payload ? gmailMessage.payload.headers : [];
  const from = headerValue(headers, 'From');
  const subject = headerValue(headers, 'Subject');
  const messageIdHeader = headerValue(headers, 'Message-Id') || headerValue(headers, 'Message-ID');
  const dateHeader = headerValue(headers, 'Date');
  const internalDateMs = parseInt(gmailMessage.internalDate || '0', 10);
  const { text, html } = extractBodyParts(gmailMessage.payload);

  return {
    providerMessageId: gmailMessage.id,
    providerThreadId: gmailMessage.threadId,
    messageIdHeader,
    from,
    subject,
    snippet: gmailMessage.snippet || '',
    bodyText: bestPlainText(text, html),
    // Raw HTML part, if the message has one - stored alongside bodyText so
    // the ticket thread can render the real formatted email (see
    // renderThread/sanitizeRichHtml in public/app.js) instead of a stripped-
    // down text approximation, and so bestPlainText's fallback above has
    // something to work with for HTML-only senders.
    bodyHtml: html || null,
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

// Fetches every message in a Gmail thread (not just what's newer than a
// checkpoint) and normalizes each one, tagging its direction based on Gmail's
// own SENT label. Used for backfilling a ticket's full conversation history
// into ticket_messages (see scripts/backfill-thread-messages.js) - the
// regular checkpoint-based listNewMessages/listSentMessages scans can
// permanently miss messages that predate a ticket's creation (the mailbox's
// own original outbound message, before anyone had replied) or that arrive
// after a ticket's status has already moved past the point poller.js was
// still recording Sent messages for - this fetches the ground truth for one
// thread directly instead of relying on those incremental checkpoints.
async function getThreadMessages(mailboxRow, threadId) {
  const gmail = clientFor(mailboxRow);
  const { data } = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });
  return (data.messages || []).map((raw) => {
    const normalized = normalizeMessage(raw);
    const labelIds = raw.labelIds || [];
    return { ...normalized, direction: labelIds.includes('SENT') ? 'outbound' : 'inbound' };
  });
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
// to/cc/bcc are arrays of bare email addresses - Cc/Bcc header lines are
// only added when non-empty, same as composing a normal email (Bcc is
// stripped from what recipients see by Gmail's own send pipeline, same as
// it would be for a message composed directly in Gmail; the addresses
// still receive their copy). When bodyHtml is provided (the rich-text
// reply editor - bold/italic/underline/bullets), the message is sent as
// multipart/alternative with both the HTML and a plain-text fallback, so
// it renders formatted in HTML-capable clients while still degrading
// gracefully in plain-text-only ones.
async function sendReply(mailboxRow, { threadId, messageIdHeader, to, cc, bcc, subject, bodyText, bodyHtml }) {
  const gmail = clientFor(mailboxRow);

  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || ''}`;
  const toList = Array.isArray(to) ? to : [to].filter(Boolean);
  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : [];
  const bccList = Array.isArray(bcc) ? bcc.filter(Boolean) : [];

  const lines = [
    `From: ${mailboxRow.email}`,
    `To: ${toList.join(', ')}`,
  ];
  if (ccList.length) lines.push(`Cc: ${ccList.join(', ')}`);
  if (bccList.length) lines.push(`Bcc: ${bccList.join(', ')}`);
  lines.push(`Subject: ${encodeHeaderIfNeeded(replySubject)}`);
  if (messageIdHeader) {
    lines.push(`In-Reply-To: ${messageIdHeader}`);
    lines.push(`References: ${messageIdHeader}`);
  }
  lines.push('MIME-Version: 1.0');

  if (bodyHtml) {
    const boundary = `----=_MailTicketTool_${Date.now()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('');
    lines.push(bodyText || '');
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('');
    lines.push(bodyHtml);
    lines.push('');
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('');
    lines.push(bodyText || '');
  }

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
  getThreadMessages,
  sendReply,
};
