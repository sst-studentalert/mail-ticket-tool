# Mail Ticket Tool

A lightweight, self-hostable email ticketing tool for a small team sharing 3-4
Gmail / Google Workspace mailboxes. It polls each connected mailbox's inbox
every few minutes via the **Gmail API** (no IMAP, no shared passwords), turns
new emails into tickets, lets the team assign/tag/reply from a simple web UI,
and automatically flags likely no-reply/automated mail so it doesn't skew your
stats.

Backed by Postgres (works with a local Postgres container for team testing, or
a managed Postgres like [Neon](https://neon.tech) for a real deployment). Runs
either as a single always-on Docker container (with an in-process poller) or
as a serverless deployment on Vercel (with polling driven by Vercel Cron
instead) - see **Deploying to Vercel + Neon** below.

## What you get

- **Tickets**: one per email thread, deduped by Gmail message id. A
  follow-up message in an already-ticketed thread updates that same ticket
  (and reopens it if it had been replied/closed) instead of creating a
  duplicate.
- **Roles**: every team member is either an **admin** (sees/manages
  everything - all tickets, roster, mailboxes, team-wide Dashboard) or an
  **agent** (only ever sees tickets assigned to them; can reply/tag/change
  status/toggle automated on their own tickets, but can't reassign, manage
  mailboxes/roster, or see the team Dashboard).
- **Assignment**: admins assign any ticket to anyone on the roster. Assigning
  sets status to `assigned`.
- **Tags**: free-text tags per ticket, searchable.
- **Automated-email detection**: a heuristic (List-Unsubscribe header,
  Precedence: bulk/auto_reply/junk, no-reply-style From addresses,
  Auto-Submitted header, "out of office"/"delivery status" style subjects)
  flags likely bot/no-reply mail. Anyone can manually override the flag;
  manual overrides always win over the heuristic and it's excluded from
  every stats view either way.
- **Replies, three ways**: send a real reply through Gmail (properly
  threaded via `In-Reply-To`/`References`/`threadId`), manually mark a
  ticket "replied externally," or have it **auto-detected** - the poller also
  scans each mailbox's Sent folder, and if it finds an outgoing message in an
  open ticket's thread, marks it replied automatically (`last_reply_mode:
  external_detected`). All three are logged in the ticket's history.
- **TAT (turnaround time)**, tracked per ticket and shown three ways:
  - On every individual ticket (list column + detail panel): first-response
    and resolution time, live, the moment it happens.
  - Team-wide Dashboard (admin-only): per-person + aggregate TAT.
  - **My Stats** (everyone, including agents): your own ticket counts by
    status, per-mailbox breakdown, and your own TAT - agents get this since
    they can't see the team Dashboard, and admins get a "my own work" view
    separate from the team-wide one.
  - TAT milestones (`assigned_at`, `first_replied_at`, `closed_at`) are only
    ever set once, so a thread reopening later doesn't reset the clock.
- **Date range filters**: both Tickets and the Dashboard/My Stats support
  From/To date filters (by the ticket's original arrival date), so every
  number on screen updates to that window.
- **Mailbox admin** (admin-only): connect/disconnect mailboxes via Google
  OAuth - each mailbox owner grants access themselves, nobody shares a
  password.
- **Roster admin**: admins add/remove/edit team members (name, email, admin
  flag, password reset). Anyone can edit their own name/password via the
  "My account" button, even agents who don't see the Team page.

## Team testing quickstart (Docker, no compiling anything)

This is the fastest path to get teammates testing without anyone fighting
native-module install errors on their own machine - Docker builds everything
inside a clean container instead.

1. Install Docker Desktop (docker.com) if you don't have it.
2. Clone this repo:
   ```
   git clone <this-repo-url>
   cd mail-ticket-tool
   ```
3. Copy `.env.example` to `.env` and fill in real values (see Steps 1-3
   below for the Google OAuth part - only needs doing once, by whoever sets
   this up, not by every tester). Leave `DATABASE_URL`/`DATABASE_SSL` unset -
   `docker-compose.yml` spins up its own local Postgres container and points
   the app at it automatically.
4. `docker-compose up -d` (starts both the app and a local `postgres`
   container; first run also applies schema migrations automatically).
5. Open `http://localhost:3000`, log in with the admin credentials from
   `.env`, and add your teammates on the **Team** page (uncheck "Admin" for
   regular testers so they get the agent experience - only seeing tickets
   assigned to them).

Everyone testing on the same machine/network can hit the same
`http://<that-machine's-IP>:3000` URL. If people are on different machines
entirely, you'll want the shared-hosting setup (Render/Railway) instead of
everyone running their own local copy - ask if you want that walkthrough.

## Architecture (for whoever maintains this later)

```
src/
  app.js                   Builds the Express app (async: runs migrations,
                            bootstraps admin, wires session store, mounts
                            routes) - shared by both entrypoints below
  server.js                Always-on entrypoint (Docker/Render/plain `node`):
                            calls getApp(), starts listening, starts the
                            in-process poller (if enabled)
  config.js                All env vars read in one place
  db.js                    Postgres (`pg`) connection pool + schema
                            migrations + a small async db.prepare(sql).get/
                            all/run() shim so call sites read like
                            better-sqlite3
  middleware/
    requireAuth.js         Session-auth guard for API routes
    requireAdmin.js        Admin-only guard (run after requireAuth)
  services/
    mailboxProvider.js     Documents the provider adapter interface (no code)
    gmailAdapter.js         Gmail implementation of that interface (also
                            reads the Sent folder, for reply auto-detection)
    poller.js              Polls every connected mailbox's inbox
                            (creates/merges tickets, tracks
                            last_internal_date) and Sent folder (auto-marks
                            tickets replied, tracks last_sent_internal_date).
                            Runs on a node-cron schedule when
                            ENABLE_INTERNAL_POLLER=true (Docker/always-on), or
                            once per invocation when triggered by
                            routes/cron.js (Vercel)
    automatedDetection.js  Heuristic scorer (score >= threshold => flagged)
    tat.js                 Shared per-ticket TAT calculation (mirrors the
                            SQL aggregate logic in stats.js/myStats.js)
    auth.js                Password hashing (bcrypt) + first-run admin bootstrap
  routes/
    auth.js                POST /login, /logout, GET /me
    oauth.js                Google OAuth "connect mailbox" start + callback
                            (admin-only)
    mailboxes.js            List (open) / disconnect (admin-only) mailboxes
    tickets.js              List/filter (agents forced-scoped to their own),
                            detail, assign (admin-only), status, tags,
                            automated toggle, reply, mark-replied-externally
    roster.js               List (open); add/remove (admin-only); edit
                            (admin can edit anyone, anyone can self-edit
                            name/password)
    stats.js                Team-wide Dashboard aggregate counts + TAT
                            (admin-only)
    myStats.js              Personal "my tickets" counts + TAT (everyone)
    cron.js                 GET/POST /api/cron/poll - triggers one poll pass;
                            used by Vercel Cron in place of the in-process
                            scheduler (checks a CRON_SECRET bearer token)
api/
  index.js                 Vercel serverless entrypoint - wraps getApp() for
                            Vercel's Node function runtime
public/
  index.html, app.js, style.css   Plain vanilla-JS single-page app (no build step)
scripts/
  clear-tickets.js         One-off: wipes all tickets (not roster/mailboxes)
vercel.json                Vercel routing + cron schedule (see Vercel section)
```

**Why this shape:** the poller and reply routes never call Gmail directly -
they always go through the small adapter interface described at the top of
`src/services/mailboxProvider.js` (`getAuthUrl`, `handleOAuthCallback`,
`listNewMessages`, `getMessage`, `sendReply`). `src/services/poller.js` has a
tiny `PROVIDERS` registry keyed by the `mailboxes.provider` column. To add
Outlook/Microsoft Graph later: write `src/services/outlookAdapter.js`
implementing the same five functions, register it in that `PROVIDERS` map (in
both `poller.js` and `routes/tickets.js`), and add an "Connect Outlook
mailbox" button in the UI. No other file needs to change.

**Why Postgres:** a real client-server database is what lets this run as
serverless functions on Vercel (no shared disk between invocations, unlike
SQLite) and be backed up/migrated with standard tooling. Neon's free tier is
plenty for a team of a handful of people processing 50-300 emails/day, and
Neon connection strings work as-is for AWS RDS/Aurora Postgres later if you
outgrow it (see the Vercel + Neon section below).

**Why polling, not push notifications:** Gmail's push (`watch`/pub-sub)
requires a Google Cloud Pub/Sub topic per project and re-registering a
`watch()` every 7 days - more moving parts than a non-technical team should
have to operate. Polling against the Gmail API's free quota (billions of
quota units/day) comfortably handles 50-300 emails/day across 3-4 mailboxes
with zero extra infrastructure - every 3 minutes on an always-on deployment
(Docker/Render), or once a day on Vercel's free Hobby plan (more often once
you're on Vercel Pro - see below).

## Prerequisites

- Docker and Docker Compose installed on the machine that will run this.
- A Google account able to create a Google Cloud project (any of the mailbox
  owners, or a shared admin account, is fine).
- 3-4 Gmail or Google Workspace mailboxes whose owners are willing to click
  an OAuth consent button (not share their password).

## Step 1: Create a Google Cloud project and enable the Gmail API

1. Go to https://console.cloud.google.com/ and create a new project (or use
   an existing one). Name it something like "Mail Ticket Tool".
2. In the left sidebar go to **APIs & Services > Library**, search for
   **Gmail API**, and click **Enable**.
3. Go to **APIs & Services > OAuth consent screen**.
   - User type: **External** is fine (or **Internal** if all your mailboxes
     are on the same Google Workspace domain).
   - Fill in an app name (e.g. "Mail Ticket Tool"), your support email, and
     developer contact email.
   - On the **Scopes** step, add:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
     - `.../auth/userinfo.email`
   - On the **Test users** step (if your app is in "Testing" publishing
     status), add the email address of every mailbox you plan to connect.
     Google will only let *added test users* complete the consent flow until
     you submit the app for verification - for a small internal team, staying
     in "Testing" mode and listing your 3-4 mailboxes as test users is the
     simplest path and requires no Google review.

## Step 2: Create an OAuth 2.0 Client ID

1. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**.
2. Application type: **Web application**.
3. Name it anything (e.g. "Mail Ticket Tool Web").
4. Under **Authorized redirect URIs**, add exactly:
   ```
   http://YOUR-SERVER-HOST:3000/api/oauth/google/callback
   ```
   Replace `YOUR-SERVER-HOST` with wherever this will actually run (e.g. a
   real domain if you put it behind HTTPS, or `localhost` for local testing).
   This must match `BASE_URL` in your `.env` file exactly (scheme + host +
   port), because the app builds the redirect URI from `BASE_URL`.
5. Click **Create**. Copy the **Client ID** and **Client Secret** shown - you
   will paste these into `.env` in Step 3.

## Step 3: Configure environment variables

1. Copy the example file:
   ```
   cp .env.example .env
   ```
2. Edit `.env`:
   - `BASE_URL` - the URL people will use to reach this app, matching the
     redirect URI you registered in Step 2 (e.g. `http://localhost:3000` or
     `https://tickets.yourcompany.com`).
   - `SESSION_SECRET` - generate a random value:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` - the login for the very first admin
     account, created automatically the first time the app starts (only if
     no team members exist yet).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - from Step 2.
   - Leave `DATABASE_URL`/`DATABASE_SSL` unset for this Docker quickstart -
     `docker-compose.yml` provides a local Postgres automatically. Leave
     `POLL_CRON` and `AUTOMATED_SCORE_THRESHOLD` at their defaults unless you
     have a reason to change them.

## Step 4: Run it

```
docker-compose up -d
```

This builds the image, starts the container, and persists the SQLite
database in `./data/tickets.db` on the host (so `docker-compose down` /
rebuilds don't lose data). Check it's healthy:

```
curl http://localhost:3000/healthz
```

## Step 5: Log in and connect mailboxes

1. Open `http://localhost:3000` (or your real `BASE_URL`) in a browser and
   log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Go to **Team** and add your other team members (name, email, a password
   you communicate to them - they should change it isn't supported in this
   MVP, so pick something they can use, or re-add them with a new password
   later if needed).
3. Go to **Mailboxes** and click **+ Connect new mailbox**. This redirects to
   Google's consent screen. Whoever owns that mailbox should be the one
   sitting at the keyboard when this happens - they log into their own
   Google account and approve access. Repeat once per mailbox (3-4 times).
4. Within a few minutes (poll interval defaults to every 3 minutes, plus an
   initial poll ~5 seconds after the server starts) new inbox mail should
   start showing up as tickets under **Tickets**.

## Day-to-day use

- **Tickets** page: filter by mailbox, assignee, status, automated flag, or
  tag; click a row to open the detail panel.
- In the detail panel you can: change status, (re)assign, edit tags, toggle
  the automated flag (this always becomes a manual override), and either
  **Send reply** (goes out through Gmail from the ticket's source mailbox,
  threaded correctly) or **Mark replied externally** (no email sent, just
  updates status - use this when someone replied from their own Gmail/phone).
- **Dashboard**: per-person open/assigned/replied/closed counts, excluding
  anything flagged automated, plus the total automated-excluded count.

## Deploying to Vercel + Neon

This is the no-server-to-manage option: Vercel runs the app as serverless
functions, Neon is the managed Postgres database. Total cost can be $0/month
on Vercel's Hobby plan + Neon's free tier (with polling limited to once/day -
see the cron note below).

1. **Create the Neon database.**
   - Go to https://neon.tech, sign up, and create a new project (any region
     close to where Vercel will run your functions, e.g. a US region).
   - On the project's dashboard, copy the **connection string** - it looks
     like `postgres://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`.
     This is your `DATABASE_URL`. Neon requires SSL, which is already the
     default in this app (`DATABASE_SSL` defaults to `true`) - don't set
     `DATABASE_SSL=false` here.
   - Neon connection strings are also usable directly against real AWS
     (Neon runs on AWS and offers a straightforward path to move the data if
     you ever want to manage the Postgres instance yourselves on RDS/Aurora
     instead) - nothing else in this app needs to change if you switch later,
     since it's all just `DATABASE_URL`.

2. **Push this repo to GitHub** (if you haven't already):
   ```
   git init   # if not already a git repo
   git add -A
   git commit -m "Postgres + Vercel deploy"
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

3. **Import the project into Vercel.**
   - Go to https://vercel.com, sign in, click **Add New > Project**, and
     import the GitHub repo.
   - Framework preset: leave as **Other** (this isn't Next.js/etc. - Vercel
     will use `vercel.json`, already committed, to route requests to
     `api/index.js` and to install the Vercel Cron job).
   - Don't click Deploy yet - set the environment variables first (next
     step), since the first deploy will run migrations and bootstrap the
     admin user using them.

4. **Set environment variables** (Vercel project > Settings > Environment
   Variables - add each for Production, and Preview/Development too if you
   want preview deployments to work):
   - `DATABASE_URL` - the Neon connection string from step 1.
   - `DATABASE_SSL` - leave unset (defaults to `true`, which Neon requires).
   - `BASE_URL` - your Vercel deployment URL, e.g.
     `https://mail-ticket-tool.vercel.app` (or a custom domain if you attach
     one). You'll need this to also match the Google OAuth redirect URI (see
     Step 2 above) - update that redirect URI to
     `https://mail-ticket-tool.vercel.app/api/oauth/google/callback` once you
     know your real Vercel URL.
   - `SESSION_SECRET` - a random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` - first admin login.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - from Step 2 above.
   - `CRON_SECRET` - a random string. Vercel automatically sends this as
     `Authorization: Bearer <value>` to your Cron Job's URL, and
     `routes/cron.js` checks it - this stops randoms on the internet from
     triggering your poller.
   - Leave `ENABLE_INTERNAL_POLLER` **unset** (must stay `false`/absent on
     Vercel - there's no long-running process for it to run in; polling
     happens via the Cron job instead, see next step).

5. **Deploy.** Click Deploy (or push to `main` again if you already deployed
   once) - Vercel builds and deploys `api/index.js`, and on first request the
   app runs its Postgres migrations and bootstraps the admin user
   automatically (same `db.migrate()` / `bootstrapAdmin()` that Docker runs).

6. **Verify the cron job is registered.** Vercel project > Settings >
   Cron Jobs should show `/api/cron/poll` on the schedule from `vercel.json`
   (`0 0 * * *` = once a day, at midnight UTC - the max frequency allowed on
   the free Hobby plan). You can also trigger a poll manually any time to
   test it:
   ```
   curl -H "Authorization: Bearer <your CRON_SECRET>" https://mail-ticket-tool.vercel.app/api/cron/poll
   ```

7. **Log in and connect mailboxes** - same as Step 5 in the Docker
   walkthrough above, just using your Vercel URL instead of `localhost:3000`.

### Once you upgrade to Vercel Pro: polling every 3 minutes

Vercel's Hobby plan caps cron jobs at once/day, which is fine for testing but
too slow for a live support inbox. Once you're on Vercel Pro (which allows
much more frequent cron schedules), switch to the every-3-minutes schedule
that's already written and ready to go:

```
cp vercel.cron-pro-every-3min.json.example vercel.json
git add vercel.json
git commit -m "Poll every 3 minutes (Vercel Pro)"
git push
```

Vercel will pick up the new cron schedule (`*/3 * * * *`) on the next deploy -
no other code changes needed.

## Known limitations / things to know before relying on this

- **Sessions are Postgres-backed** (`connect-pg-simple`), so they survive
  restarts and work correctly across multiple serverless instances/warm
  Vercel functions running at once - no extra setup needed.
- **No password reset flow.** To change someone's password today, remove
  them from the roster and re-add them (this unassigns their tickets, so
  reassign afterward), or extend `routes/roster.js` with an edit endpoint.
- **No HTTPS termination built in.** Put this behind a reverse proxy (Caddy,
  nginx, Cloudflare Tunnel, etc.) for a real deployment reachable from the
  internet, and make sure `BASE_URL` and the Google OAuth redirect URI both
  use `https://`.
- **Polling checkpoint is by internal timestamp, not Gmail `historyId`.**
  This is intentional (see Architecture above) - it's simpler and self-heals
  if the poller is down for a while, at the cost of a small chance of
  re-scanning (not re-ticketing, since dedupe is by message id) a few extra
  messages after downtime.
- **Non-mailbox-owner replies show the shared team as the sender identity**
  only in the sense that the reply is sent *as* the mailbox's own address
  (e.g. `support@yourco.com`), which is exactly the intended behavior for a
  shared support inbox.
- **google.com/gmail attachments are not stored/rendered** - only the plain
  text/HTML-stripped body is extracted for the ticket. Extending
  `extractBody` in `src/services/gmailAdapter.js` to also list/download
  attachments is a natural next step if needed.
- The Gmail API "Testing" publishing status caps you at 100 test users and
  requires each connected mailbox to be added as a test user in the OAuth
  consent screen (Step 1). That's not a real limitation for 3-4 mailboxes,
  but if you outgrow it, submit the app for Google's verification review.

## Local development (without Docker)

You need a Postgres instance to point at - either run just the `postgres`
service from `docker-compose.yml` (`docker-compose up -d postgres`) and use
`DATABASE_URL=postgres://mailtickets:mailtickets@localhost:5432/mailtickets`
with `DATABASE_SSL=false`, or point `DATABASE_URL` at a real Neon connection
string (leave `DATABASE_SSL=true`, Neon's default).

```
npm install
cp .env.example .env   # fill in values, including DATABASE_URL
npm start
```

The server listens on `PORT` (default 3000), runs schema migrations, and
bootstraps the admin user automatically on first start.
