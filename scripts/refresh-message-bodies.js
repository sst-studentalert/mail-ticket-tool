// One-off repair script: re-fetches each ticket's Gmail thread and OVERWRITES
// the body/body_html/to_address/cc_address already stored in ticket_messages
// for any message that's already there.
//
// Why this is needed on top of backfill-thread-messages.js: recordMessage
// dedupes by gmail_message_id with `ON CONFLICT ... DO NOTHING`, so it never
// updates a message that's already been recorded - even if the value stored
// for it was wrong. That happened for messages whose sender's plain-text
// part was just a stub like "Please view this email in HTML format." while
// the real content only existed as HTML (common with corporate mailer
// templates, e.g. the Disciplinary Committee's pink-slip notices) - the old
// version of gmailAdapter.extractBody always preferred a non-empty
// text/plain part, so that stub got stored as the entire message body. The
// fix in gmailAdapter.js (bestPlainText/bodyHtml) only affects messages
// fetched AFTER the fix; this script re-fetches and fixes what's already
// sitting in the database.
//
// Safe to re-run any time - it only ever overwrites with fresh data pulled
// straight from Gmail, never invents anything.
//
//   node scripts/refresh-message-bodies.js            # every ticket with a Gmail thread
//   node scripts/refresh-message-bodies.js 219        # just ticket #219
//   node scripts/refresh-message-bodies.js disciplinarycommittee@sst.scaler.com   # just this mailbox's tickets
//
// Needs the same DATABASE_URL env var the server uses (loaded via dotenv in
// src/config.js) - if you're repairing a different deployment's data than
// the one your local .env points at, prefix with e.g.:
//   DATABASE_URL="<other project's connection string>" node scripts/refresh-message-bodies.js
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const gmailAdapter = require(path.join(__dirname, '..', 'src', 'services', 'gmailAdapter'));
const { recordMessage } = require(path.join(__dirname, '..', 'src', 'services', 'poller'));

async function main() {
  await db.migrate();

  const arg = process.argv[2];
  let tickets;
  if (arg && /^\d+$/.test(arg)) {
    tickets = await db
      .prepare(
        `SELECT t.*, m.email AS mailbox_email FROM tickets t JOIN mailboxes m ON m.id = t.mailbox_id
         WHERE t.id = ? AND t.gmail_thread_id IS NOT NULL`
      )
      .all(Number(arg));
  } else if (arg) {
    tickets = await db
      .prepare(
        `SELECT t.*, m.email AS mailbox_email FROM tickets t JOIN mailboxes m ON m.id = t.mailbox_id
         WHERE m.email = ? AND t.gmail_thread_id IS NOT NULL`
      )
      .all(arg);
  } else {
    tickets = await db
      .prepare(
        `SELECT t.*, m.email AS mailbox_email FROM tickets t JOIN mailboxes m ON m.id = t.mailbox_id
         WHERE t.gmail_thread_id IS NOT NULL`
      )
      .all();
  }

  console.log(`Refreshing message bodies for ${tickets.length} ticket(s)...`);

  const mailboxCache = new Map();
  let ticketsTouched = 0;
  let updated = 0;
  let inserted = 0;
  let failures = 0;

  for (const ticket of tickets) {
    try {
      if (!mailboxCache.has(ticket.mailbox_id)) {
        mailboxCache.set(
          ticket.mailbox_id,
          await db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(ticket.mailbox_id)
        );
      }
      const mailboxRow = mailboxCache.get(ticket.mailbox_id);
      const threadMessages = await gmailAdapter.getThreadMessages(mailboxRow, ticket.gmail_thread_id);

      let updatedForTicket = 0;
      let insertedForTicket = 0;
      for (const msg of threadMessages) {
        const existing = await db
          .prepare('SELECT id FROM ticket_messages WHERE gmail_message_id = ?')
          .get(msg.providerMessageId);

        if (existing) {
          await db
            .prepare(
              `UPDATE ticket_messages SET body = ?, body_html = ?, to_address = ?, cc_address = ? WHERE id = ?`
            )
            .run(
              msg.bodyText,
              msg.bodyHtml,
              (msg.headers && msg.headers.to) || null,
              (msg.headers && msg.headers.cc) || null,
              existing.id
            );
          updatedForTicket += 1;
        } else {
          const { inserted: wasInserted } = await recordMessage(ticket.id, {
            gmailMessageId: msg.providerMessageId,
            direction: msg.direction,
            fromAddress: msg.from,
            toAddress: msg.headers && msg.headers.to,
            ccAddress: msg.headers && msg.headers.cc,
            body: msg.bodyText,
            bodyHtml: msg.bodyHtml,
            sentAt: msg.receivedAt,
          });
          if (wasInserted) insertedForTicket += 1;
        }
      }

      if (updatedForTicket > 0 || insertedForTicket > 0) {
        ticketsTouched += 1;
        updated += updatedForTicket;
        inserted += insertedForTicket;
        console.log(
          `  Ticket #${ticket.id} ("${ticket.subject || '(no subject)'}", ${ticket.mailbox_email}): ${updatedForTicket} updated, ${insertedForTicket} inserted`
        );
      }
    } catch (err) {
      failures += 1;
      console.error(`  Ticket #${ticket.id}: failed to refresh - ${err.message}`);
    }
  }

  console.log(
    `Done. ${ticketsTouched} ticket(s) touched, ${updated} message(s) updated, ${inserted} message(s) newly inserted, ${failures} failure(s).`
  );
  await db.pool.end();
}

main().catch((err) => {
  console.error('Failed to refresh message bodies:', err);
  process.exit(1);
});
