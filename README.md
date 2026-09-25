# Notify Queue

Notify Queue is a backend service that schedules notifications (email, SMS and push) and
delivers each one exactly once, at the right time, even when many workers run at the same
time.

You send it a request such as "send this email to this person at 9:00 tomorrow" or "send
this SMS in 60 seconds". It stores the notification, waits until it is due, and then
delivers it. If delivery fails, it retries. If a notification keeps failing, it moves it to
a dead-letter queue instead of retrying forever.

- **How the system is designed, in plain English:** [DESIGN.md](DESIGN.md)
- **Full technical design, for engineers:** [docs/technical-design.md](docs/technical-design.md)

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Run it with Docker (quickest)](#run-it-with-docker-quickest)
- [Run it locally with npm](#run-it-locally-with-npm)
- [Run several workers locally](#run-several-workers-locally)
- [Using the API](#using-the-api)
- [Tests](#tests)
- [Settings](#settings)
- [Known limitations](#known-limitations)
- [Project structure](#project-structure)

## Features

- **Scheduling:** send at a set time (`sendAt`) or after a delay in seconds (`delaySeconds`).
- **Priority:** HIGH, NORMAL and LOW. When several notifications are due, HIGH goes first.
- **Exactly-once delivery:** many workers can run at once, and a notification is never
  delivered twice, even if a worker crashes.
- **Duplicate protection:** every request has an idempotency key. Sending the same request
  twice creates only one notification.
- **Retries with exponential backoff:** each retry waits about twice as long as the last.
- **Dead-letter queue:** after 6 failed attempts, a notification is set aside. An operator
  can retry it later, one at a time or many at once.
- **Rate limiting:** at most 10 notifications per recipient per rolling hour. Extra
  notifications wait; they are not failed.
- **Webhooks:** your system is told when a notification is sent, fails or is dead-lettered.
- **Status and metrics:** look up any notification, and see live counts for the whole queue.
- **Operator actions:** list notifications, cancel one that has not been sent, and retry
  notifications from the dead-letter queue, one at a time or in batches.

## How it works

```
 Your system ──▶  API  ──▶  PostgreSQL  ◀──  Workers ──▶ Email / SMS / Push
                            (every notification      pick up due notifications
                             and its status)         and deliver them
```

There are three parts:

1. **The API** receives requests, checks them, and saves notifications to the database.
2. **PostgreSQL** stores every notification and its status. It also acts as the queue.
3. **Workers** find notifications that are due and deliver them. You can run as many
   workers as you need. They never talk to each other, only to the database.

The API and the workers are the same program. The `APP_ROLE` setting decides which job a
copy does: `api`, `worker`, or `all` (both, which is convenient on a laptop).

## Requirements

- Node.js 22.13 or newer, with npm
- Docker, with Docker Compose

## Run it with Docker (quickest)

Run these commands in the project folder:

| Command | What it does |
| --- | --- |
| `npm run docker:up` | Builds and starts PostgreSQL, the API and three workers |
| `npm run docker:seed` | Loads example notifications |
| `npm run docker:logs` | Shows what the workers are doing (press Ctrl+C to stop watching) |
| `npm run docker:down` | Stops everything and keeps your data |

The API is then available at **http://localhost:3000**, and the interactive API
documentation (Swagger) is at **http://localhost:3000/api/docs**.

To start from an empty database, run `docker compose down -v` before `npm run docker:up`.

If port 3000 is already in use on your computer, start the stack on another port:
`API_HOST_PORT=3100 docker compose up --build -d --scale worker=3`.

## Run it locally with npm

Run each command in the project folder, in this order:

```bash
npm ci
```

```bash
cp .env.example .env
```

```bash
docker compose up -d postgres
```

```bash
npm run migration:run
```

```bash
npm run seed
```

```bash
npm run start:dev
```

What each step does:

1. Installs the dependencies.
2. Creates your settings file. The default values work as they are.
3. Starts PostgreSQL in Docker, on port 5434 (so it does not clash with another
   PostgreSQL on the usual port).
4. Creates the database tables.
5. Loads example notifications. This step is optional, and it is safe to run twice.
6. Starts the API and one worker together, and restarts them when the code changes.

Do not run `npm run start:dev` and the Docker stack at the same time: both use port 3000.

## Run several workers locally

Start the API on its own, then start each worker in its own terminal window:

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

Each worker needs its own `PORT` (it serves a health check there). `WORKER_ID` is optional;
it names the worker in the logs.

When you stop a worker with Ctrl+C, it finishes the notifications it is currently sending,
returns any it has not started to the queue, and then exits.

## Using the API

The easiest way to try the API is Swagger, at **http://localhost:3000/api/docs**. Open an
endpoint, click **Try it out**, and then click **Execute**. The examples below use `curl`
instead.

**Schedule a notification** to be sent in 60 seconds:

```bash
curl -X POST http://localhost:3000/notifications \
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
- Send either `delaySeconds` or `sendAt` (for example `"2026-12-01T09:00:00Z"`), not both.
- `idempotencyKey` is a unique key that you choose for this notification. If you send the
  same request again with the same key, no second notification is created.

The response contains the notification's `id`. Use that `id` in the requests below. (The
`id` shown in these examples is only a placeholder.)

**Check a notification's status:**

```bash
curl http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c
```

A notification moves from `PENDING` (waiting) to `PROCESSING` (being sent) to `SENT`. It can
also end as `FAILED` (it can never be delivered), `DEAD_LETTERED` (it kept failing) or
`CANCELLED`.

**List notifications**, newest first. You can filter by status, by recipient, or both:

```bash
curl 'http://localhost:3000/notifications?status=DEAD_LETTERED'
```

Long lists are returned in pages. Each page includes a `nextCursor` value; pass it as
`&cursor=...` to get the next page.

**Cancel** a notification that has not been sent yet:

```bash
curl -X DELETE http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c
```

**Retry** a notification from the dead-letter queue (or one that failed):

```bash
curl -X POST http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c/retry
```

**Retry many at once**, for example the whole dead-letter queue after an outage:

```bash
curl -X POST http://localhost:3000/notifications/retry
```

The response says how many were retried and how many remain, for example
`{ "retried": 100, "remaining": 250 }`. Each call retries up to 100 notifications, oldest
first; repeat it until `remaining` is 0. You can send a body to change this:

- `status`: `DEAD_LETTERED` (the default) or `FAILED`.
- `recipient`: only this recipient's notifications.
- `limit`: how many to retry in one call, from 1 to 1,000.

A retried notification starts again with 6 attempts. If it keeps failing, it goes back to
the dead-letter queue.

**See the queue metrics** and **check the service health:**

```bash
curl http://localhost:3000/metrics
```

```bash
curl http://localhost:3000/health
```

### All endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/notifications` | Schedule a notification |
| `GET` | `/notifications` | List notifications, filtered by `status` and/or `recipient` |
| `GET` | `/notifications/{id}` | Get one notification's status and history |
| `DELETE` | `/notifications/{id}` | Cancel a notification that has not been sent |
| `POST` | `/notifications/{id}/retry` | Retry a dead-lettered or failed notification |
| `POST` | `/notifications/retry` | Retry many dead-lettered or failed notifications at once |
| `GET` | `/metrics` | Counts by status, and how long the oldest due notification has waited |
| `GET` | `/health` | Whether the service and the database are working |
| `POST` | `/webhooks/mock` | A demo receiver for webhook calls |

### Response codes

| Code | Meaning |
| --- | --- |
| `201` | A new notification was created |
| `200` | Success. For a repeated request with the same idempotency key, this returns the original notification |
| `400` | The request is invalid; the response explains why |
| `404` | No notification has that `id` |
| `409` | The action is not allowed in the notification's current state, or the idempotency key was already used for a different request |

Every response includes an `X-Request-ID` header. The same ID appears in the logs, which
makes problems easy to trace.

## Tests

The tests need PostgreSQL running (`docker compose up -d postgres`). Then run:

```bash
npm test
```

| Command | What it tests |
| --- | --- |
| `npm run test:unit` | Individual rules, such as how long to wait between retries |
| `npm run test:integration` | The API, the workers, retries and webhooks, against a real database |
| `npm run test:concurrency` | Many workers and requests at the same time |

The concurrency tests prove the main guarantees:

- **No duplicate delivery:** 10 workers try to take the same notification at the same
  moment, 25 times in a row. Exactly one succeeds every time.
- **No duplicate notifications:** 25 identical requests sent at once create one notification.
- **The rate limit holds:** 10 workers competing for one recipient never exceed the limit.
- **Cancel versus delivery:** 200 cancellations race against workers; each notification is
  either cancelled or delivered, never both.

The tests use a separate test database, so they never touch your data. They do not depend
on luck: random failures are switched off, and failures are scripted instead.

## Settings

Settings are read from the `.env` file. `.env.example` describes every setting. The service
refuses to start if a setting is invalid, and it lists every problem it finds.

| Setting | Default | Meaning |
| --- | --- | --- |
| `APP_ROLE` | `all` | `api`, `worker`, or `all` (both) |
| `PORT` | `3000` | The HTTP port |
| `WORKER_CONCURRENCY` | `10` | How many notifications one worker sends at the same time |
| `WORKER_BATCH_SIZE` | `100` | How many notifications one worker takes from the queue at once |
| `MAX_RETRIES` | `5` | Retries after the first attempt, so 6 attempts in total |
| `BASE_RETRY_DELAY_MS` | `1000` | The wait before the first retry, in milliseconds |
| `MAX_RETRY_DELAY_MS` | `60000` | The longest wait between retries, in milliseconds |
| `MOCK_FAILURE_RATE` | `0.2` | How often the simulated email/SMS service fails (0.2 means 20%) |
| `RATE_LIMIT_MAX_NOTIFICATIONS` | `10` | The most notifications one recipient can receive per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `3600` | The rate-limit window (one hour) |
| `JOB_VISIBILITY_TIMEOUT_SECONDS` | `300` | How long before a crashed worker's notifications are given to another worker |
| `WEBHOOK_URL` | the demo receiver | Where webhook calls are sent. If you run the API on a port other than 3000, update this too |

## Known limitations

- **The email/SMS service is simulated.** The exactly-once guarantee assumes the real
  service supports idempotency keys, which most do.
- **There is no authentication.** Anyone who can reach the API can use every endpoint.
- **Priority is strict.** If HIGH notifications arrive non-stop, LOW notifications can wait
  a long time.
- **Bursts can be shared unevenly.** With the default batch size of 100, one worker may take
  most of a sudden burst. A smaller `WORKER_BATCH_SIZE` spreads the work more evenly.
- **A recipient with a large backlog creates extra work.** Workers repeatedly pick up and
  defer notifications that are over the rate limit. The result is correct, but not efficient.
- **Webhooks are not signed**, so a receiver cannot verify that a call came from this service.

## Project structure

```
src/
├── notifications/   the API: schedule, get, list, cancel and retry notifications
├── workers/         find due notifications and deliver them
├── delivery/        the connection to the (simulated) email/SMS/push service
├── retry/           retry timing and the dead-letter decision
├── rate-limit/      the per-recipient rate limit
├── webhooks/        webhook calls to your system
├── metrics/         queue metrics
├── health/          the health check
├── database/        tables (migrations) and the example-data loader
├── config/          settings and their validation
└── common/          shared code: errors, logging, request IDs
tests/               unit, integration and concurrency tests
seed.sql             example notifications
docs/                the full technical design
```
