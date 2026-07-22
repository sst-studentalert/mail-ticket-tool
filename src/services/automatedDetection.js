// Heuristic scorer for "this email is probably automated / no-reply", run
// once at ticket-creation time. Every signal that fires adds to a score and
// is recorded in automated_reason so a human can see why it was flagged.
// This is intentionally simple (no ML) so a non-technical team can read and
// tweak it.
const config = require('../config');

const SUBJECT_PATTERNS = [
  /delivery status notification/i,
  /undeliverable/i,
  /undelivered mail/i,
  /out of office/i,
  /automatic reply/i,
  /auto-?reply/i,
  /automated response/i,
  /mail delivery (failed|failure)/i,
  /returned mail/i,
  /failure notice/i,
];

const FROM_PATTERNS = [
  /no-?reply/i,
  /do-?not-?reply/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster@/i,
];

/**
 * @param {object} message - normalized message shape produced by the mailbox
 *   adapter: { from, subject, headers: { [lowercaseName]: value } }
 * @returns {{ score: number, reasons: string[], isAutomated: boolean }}
 */
function scoreMessage(message) {
  const reasons = [];
  let score = 0;
  const headers = message.headers || {};
  const from = message.from || '';
  const subject = message.subject || '';

  const listUnsubscribe = headers['list-unsubscribe'];
  if (listUnsubscribe) {
    score += 1;
    reasons.push('List-Unsubscribe header present');
  }

  const precedence = (headers['precedence'] || '').toLowerCase();
  if (['bulk', 'auto_reply', 'junk'].includes(precedence)) {
    score += 2;
    reasons.push(`Precedence: ${precedence}`);
  }

  const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    score += 2;
    reasons.push(`Auto-Submitted: ${autoSubmitted}`);
  }

  for (const pattern of FROM_PATTERNS) {
    if (pattern.test(from)) {
      score += 2;
      reasons.push(`From address matches ${pattern}`);
      break;
    }
  }

  for (const pattern of SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      score += 1;
      reasons.push(`Subject matches ${pattern}`);
      break;
    }
  }

  const xAutoResponse = headers['x-autoresponder'] || headers['x-autoreply'];
  if (xAutoResponse) {
    score += 2;
    reasons.push('X-Autoresponder/X-Autoreply header present');
  }

  return {
    score,
    reasons,
    isAutomated: score >= config.automatedScoreThreshold,
  };
}

module.exports = { scoreMessage };
