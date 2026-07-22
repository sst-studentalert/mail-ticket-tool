// Generic "mailbox provider" interface. Every provider adapter (Gmail today,
// maybe Outlook/Graph tomorrow) must implement this shape so the poller and
// reply routes never need to know which provider they're talking to.
//
// A provider adapter module exports:
//
//   getAuthUrl(state) -> string
//       Build the OAuth consent URL for connecting a new mailbox.
//
//   handleOAuthCallback(code) -> Promise<{ email, refreshToken, accessToken, expiryDate }>
//       Exchange an auth code for tokens and resolve the mailbox's own email address.
//
//   listNewMessages(mailboxRow) -> Promise<NormalizedMessage[]>
//       Return new INBOX messages since the mailbox's last checkpoint
//       (implementation tracks its own checkpoint fields on the mailbox row,
//       e.g. last_history_id / last_internal_date for Gmail).
//
//   getMessage(mailboxRow, providerMessageId) -> Promise<NormalizedMessage>
//       Fetch full details (used mainly internally by listNewMessages, but
//       exposed for completeness / re-fetching a thread).
//
//   sendReply(mailboxRow, { threadId, messageIdHeader, to, subject, bodyText }) -> Promise<{ id, threadId }>
//       Send a reply properly threaded to the original message.
//
// NormalizedMessage shape (what the rest of the app consumes, provider-agnostic):
//   {
//     providerMessageId, providerThreadId, messageIdHeader,
//     from, subject, snippet, bodyText, receivedAt (ISO string),
//     headers: { [lowercase header name]: value }
//   }

module.exports = {};
