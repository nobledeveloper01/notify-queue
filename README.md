# Notify Queue

Notify Queue is a service that **sends notifications (email, text message or app alerts)
at the right time, exactly once**, even when many copies of it run side by side and
things go wrong.

A business tells it "send this message to this person at 9 am tomorrow" or "send this in
ten minutes". Notify Queue keeps the message until it is due, then sends it. It handles
the awkward cases: a delivery service that is briefly down, the same request arriving
twice, a computer crashing half-way through, or one person being sent too many messages
in an hour.

- **How it works, in plain language:** [DESIGN.md](DESIGN.md)
- **Full technical design, for engineers:** [docs/technical-design.md](docs/technical-design.md)

## Contents

- [What it can do](#what-it-can-do)
- [How it fits together](#how-it-fits-together)
- [What you need](#what-you-need)
- [Getting it running](#getting-it-running)
- [Running several workers](#running-several-workers)
- [Running everything with Docker](#running-everything-with-docker)
- [Using it](#using-it)
- [Interactive API documentation](#interactive-api-documentation)
- [Checking that it works (tests)](#checking-that-it-works-tests)
- [Settings](#settings)
- [How the tricky parts are handled](#how-the-tricky-parts-are-handled)
- [Known limitations](#known-limitations)
- [Where things are in the code](#where-things-are-in-the-code)

## What it can do

- **Schedule** a notification for a specific time, or for a number of seconds from now.
- **Send urgent ones first.** Each notification is HIGH, NORMAL or LOW priority.
- **Never send one twice**, even with many senders working at once and computers
  crashing.
- **Ignore repeated requests.** The same request sent twice creates one notification.
- **Retry failures** with growing pauses, and **set aside** ones that keep failing (the
  "dead-letter queue") instead of retrying forever.
- **Limit messages per person**: at most 10 per rolling hour by default. Extra ones wait
  their turn instead of failing.
- **Send status updates** (webhooks) to the business's own system when a notification is
  sent, fails, or is set aside.
- **Let you look things up**: one notification's status, lists by status or by
  recipient, and overall numbers.
- **Let you step in**: cancel a notification that has not been sent yet, or re-try one that
  was set aside.

## How it fits together

```
 Businesses ──▶  API (front desk)  ──▶  Database (the ledger)  ◀──  Workers (couriers) ──▶ Email / SMS / push
                 takes requests         every notification           pick up due messages
                                        and its status               and send them
```

- The **API** accepts requests and answers questions.
- The **database** (PostgreSQL) is the single, shared record of everything.
- **Workers** pick up notifications that are due and send them. You can run as many as
  you like; they coordinate only through the database.

The same program plays either role. A setting called `APP_ROLE` decides whether a copy is
the front desk (`api`), a courier (`worker`), or both (`all`, handy on a laptop).

## What you need

- **Node.js** version 22.13 or newer (the program's runtime)
- **npm** (comes with Node.js)
- **Docker**, to run the database (or the whole system) without installing it by hand

## Getting it running

Run these commands from the project folder, one at a time.

**1. Install the program's building blocks.**

```bash
npm ci
```

**2. Create your settings file** from the example. The defaults work as they are.

```bash
cp .env.example .env
```

**3. Start the database.** This runs PostgreSQL in Docker on port 5434, chosen so it
does not clash with a database you may already have on the usual port.

```bash
docker compose up -d postgres
```

**4. Create the database tables.**

```bash
npm run migration:run
```

**5. (Optional) Load example notifications**, covering every interesting case: urgent and
low-priority messages, one scheduled for later, one mid-retry, one set aside, a busy
recipient who will hit the hourly limit, and more. Running it twice does no harm.

```bash
npm run seed
```

**6. Start it.** This runs the front desk and a worker together, and restarts when the
code changes.

```bash
npm run start:dev
```

The service is now at **http://localhost:3000**, with interactive documentation at
**http://localhost:3000/api/docs**.

## Running several workers

To see several couriers sharing the work, run the front desk on its own, then start as
many workers as you like, each in its own terminal window:

```bash
npm run build
npm run start:api
```

```bash
PORT=3001 WORKER_ID=worker-1 npm run start:worker
```

```bash
PORT=3002 WORKER_ID=worker-2 npm run start:worker
```

```bash
PORT=3003 WORKER_ID=worker-3 npm run start:worker
```

Each worker needs its own `PORT` (it answers health checks there) and can have a
`WORKER_ID` so you can tell them apart in the logs. When a worker is stopped (Ctrl+C),
it finishes the messages it is sending, hands back the ones it had not started, and
exits.

## Running everything with Docker

One command starts the database, the front desk and a worker:

```bash
docker compose up --build
```

Three workers instead of one:

```bash
docker compose up --build --scale worker=3
```

Load the example notifications into it:

```bash
docker compose --profile seed run --rm seed
```

If port 3000 is already taken on your computer, choose another:
`API_HOST_PORT=3100 docker compose up --build`. Workers cannot be reached from outside,
and the database can be reached only from your own computer (port 5434), never from the
network.

## Using it

The examples use `curl`, a command-line tool for talking to web services. The same
requests can be made from the interactive documentation page instead.

**Schedule a notification** to go out in 60 seconds:

```bash
curl -s -X POST http://localhost:3000/notifications \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "user@example.com",
    "channel": "EMAIL",
    "payload": { "subject": "Welcome", "body": "Welcome to Notify Queue" },
    "priority": "HIGH",
    "delaySeconds": 60,
    "idempotencyKey": "welcome-user-123"
  }'
```

- `channel` is `EMAIL`, `SMS` or `PUSH`.
- Use either `delaySeconds` (send after this many seconds) **or** `sendAt` (send at this
  exact time, such as `"2026-09-27T12:00:00Z"`), not both.
- `idempotencyKey` is your own unique order number for this notification. Sending the
  same request again with the same key does not create a second notification.

The reply includes the notification's `id` (its tracking number) and `"status": "PENDING"`.

**Check on it** using that id:

```bash
curl -s http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c
```

Its `status` moves from `PENDING` (waiting) to `PROCESSING` (being sent) to `SENT`.
If sending goes wrong it may instead end as `FAILED` (can never be delivered) or
`DEAD_LETTERED` (kept failing, set aside). If you cancelled it, it shows `CANCELLED`.

**List notifications**, newest first. Filter by status, by recipient, or both:

```bash
curl -s 'http://localhost:3000/notifications?status=DEAD_LETTERED'
curl -s 'http://localhost:3000/notifications?recipient=user@example.com'
```

Long lists come in pages. Each page includes a `nextCursor`; pass it back as
`&cursor=…` to get the next page.

**Cancel** a notification that has not been sent yet:

```bash
curl -s -X DELETE http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c
```

**Re-try** one that was set aside or failed, with a fresh set of attempts:

```bash
curl -s -X POST http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c/retry
```

**See the overall numbers**, and check the service is healthy:

```bash
curl -s http://localhost:3000/metrics
curl -s http://localhost:3000/health
```

### All the endpoints

| Method | Address | What it does |
| --- | --- | --- |
| `POST` | `/notifications` | Schedule a notification |
| `GET` | `/notifications` | List notifications (filter by `status`, `recipient`) |
| `GET` | `/notifications/{id}` | One notification's status and history |
| `DELETE` | `/notifications/{id}` | Cancel it, if it has not started sending |
| `POST` | `/notifications/{id}/retry` | Re-try one that was set aside or failed |
| `GET` | `/metrics` | Counts by status, and how long the oldest waiting message has waited |
| `GET` | `/health` | Whether the service and its database are working |
| `POST` | `/webhooks/mock` | A pretend "business system" that receives status updates, for demonstrations |

### What the replies mean

| Code | Meaning |
| --- | --- |
| `200` | OK. For a repeated schedule request, it means "already done; here is the original" |
| `201` | Created: a new notification was scheduled |
| `400` | Something in the request is wrong; the reply says what |
| `404` | No notification with that id |
| `409` | Not allowed right now: cancelling one that is already being sent, re-trying one that did not fail, or reusing an order number for different details |

Every reply carries an `X-Request-ID` header. Quote it when reporting a problem; the same
ID appears in the service's logs.

## Interactive API documentation

Open **http://localhost:3000/api/docs** in a browser. It lists every endpoint with its
fields and possible replies, and has a "Try it out" button to send real requests.

## Checking that it works (tests)

The tests need the database running (step 3 above). Then:

```bash
npm test
```

That runs every test. They are grouped:

| Group | What it checks | Run just this group |
| --- | --- | --- |
| Unit | Individual rules in isolation, such as how long to wait between retries | `npm run test:unit` |
| Integration | Real behaviour against a real database: the API, workers, retries, webhooks | `npm run test:integration` |
| Concurrency | The hard cases, with many things happening at once | `npm run test:concurrency` |

The concurrency tests prove the headline promises under pressure:

- **No duplicate sends:** ten workers grab for the same notification at the same moment,
  repeatedly, and every time exactly one gets it. Three hundred notifications spread
  across ten workers are each sent exactly once.
- **No duplicate notifications:** twenty-five identical requests arriving together create
  one notification.
- **Rate limit holds:** ten workers competing to message one person never exceed the
  limit.
- **Status updates go out once each:** six senders working through sixty updates at once.
- **Cancel versus send:** two hundred cancels racing workers; each notification ends one
  way or the other, never both.

Tests always use a separate test database, so they never touch your data. They never
depend on luck: the random failures used in normal running are switched off, and failures
are scripted instead.

## Settings

All settings live in the `.env` file. The example file explains each one, and the service
refuses to start if a value is invalid, listing every problem. The ones you are most
likely to change:

| Setting | Default | What it controls |
| --- | --- | --- |
| `APP_ROLE` | `all` | `api` (front desk), `worker` (courier) or `all` (both) |
| `PORT` | `3000` | The port the service listens on |
| `WORKER_CONCURRENCY` | `10` | How many notifications one worker sends at the same time |
| `WORKER_BATCH_SIZE` | `100` | How many notifications one worker may take at once |
| `MAX_RETRIES` | `5` | Retries after the first try (so 6 attempts in total) |
| `BASE_RETRY_DELAY_MS` / `MAX_RETRY_DELAY_MS` | `1000` / `60000` | The first pause before a retry, and the longest pause (in milliseconds) |
| `MOCK_FAILURE_RATE` | `0.2` | How often the pretend delivery service fails at random (0.2 = 20%) |
| `RATE_LIMIT_MAX_NOTIFICATIONS` / `RATE_LIMIT_WINDOW_SECONDS` | `10` / `3600` | At most 10 per person per hour |
| `WEBHOOK_URL` | the pretend receiver | Where status updates are sent. It points at the front desk's own demo receiver on port 3000, so if you move the front desk to another port, change this too |
| `JOB_VISIBILITY_TIMEOUT_SECONDS` | `300` | How long before a crashed worker's notifications are handed to another worker |

The remaining settings (database connection, timeouts, log detail) are described in
`.env.example`.

## How the tricky parts are handled

These are explained fully, in plain language, in [DESIGN.md](DESIGN.md). In short:

- **Only one worker can take a notification.** Taking one locks it in the database in a
  single step; other workers skip it and take the next.
- **"Exactly once" delivery.** Every attempt at a notification uses the same reference
  number. If a worker crashes right after sending, the retry reuses that number and the
  delivery service recognises it, so the person gets one message. This relies on the
  delivery service honouring reference numbers, as most real ones do.
- **Retries.** Pauses double each time (½–1 s, then 1–2 s, then 2–4 s, and so on, up to one
  minute), with a little randomness so failures do not all retry together.
- **Dead-letter queue.** After six failed attempts a notification is set aside, kept with
  its history, listed on request, and can be re-tried by hand.
- **Rate limit.** Counted over the last sixty minutes from now, not per calendar hour, so
  there is no double burst around the hour mark. Extra notifications wait for the next free
  slot.
- **Status updates.** Recorded in the same step as the status change, so a crash cannot
  lose one; retried if the receiving system is down; each has an ID so a repeat can be
  spotted.

## Known limitations

- **Sending is simulated.** A stand-in delivery service is used. Real services need to
  support reference numbers for the "exactly once" promise to hold end to end.
- **No logins.** Anyone who can reach the service can use it, including cancelling and
  re-trying notifications. A real deployment would add authentication.
- **Priority is strict.** A constant stream of urgent notifications could keep low-priority
  ones waiting indefinitely.
- **Work can be shared unevenly in bursts.** With the default batch size, the first worker
  to look during a sudden burst can take up to 100 notifications while others find few. A
  smaller `WORKER_BATCH_SIZE` spreads bursts more evenly.
- **A very busy recipient causes extra work.** If thousands of notifications wait for one
  person, workers keep checking and putting them back. The result is correct but wasteful.
- **Status updates are not signed**, so a receiver cannot prove an update came from us. A
  real deployment would add a signature.

## Where things are in the code

```
src/
├── notifications/   the front desk: scheduling, looking up, listing, cancelling, re-trying
├── workers/         the couriers: picking up due notifications and sending them
├── delivery/        the connection to the (pretend) delivery service
├── retry/           how long to wait, and when to give up
├── rate-limit/      the per-person hourly limit
├── webhooks/        status updates to other systems
├── metrics/         the overall numbers
├── health/          the health check
├── database/        table definitions and the example data loader
├── config/          the settings and their checks
└── common/          shared pieces: error messages, logging, request IDs
tests/               unit, integration and concurrency tests
seed.sql             the example notifications
docs/                the full technical design
```
