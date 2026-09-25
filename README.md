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
- [API reference](#api-reference)
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

## API reference

This section describes every endpoint, with a sample request and the response it returns,
so you can see the whole API without running the project. All the responses below were
captured from the running service. Only the IDs and times will differ on your machine.

To try the endpoints yourself, open Swagger at **http://localhost:3000/api/docs**, choose an
endpoint, click **Try it out**, and then click **Execute**.

**Base URL:** `http://localhost:3000`. Requests and responses are JSON. There is no
authentication (see [Known limitations](#known-limitations)).

### Endpoints at a glance

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `POST` | [`/notifications`](#schedule-a-notification) | Schedule a notification | `201`, or `200` for a repeat |
| `GET` | [`/notifications/{id}`](#get-a-notification) | Get one notification and its status | `200` |
| `GET` | [`/notifications`](#list-notifications) | List notifications, filtered by status and/or recipient | `200` |
| `DELETE` | [`/notifications/{id}`](#cancel-a-notification) | Cancel a notification that has not been sent | `200` |
| `POST` | [`/notifications/{id}/retry`](#retry-one-notification) | Retry one dead-lettered or failed notification | `200` |
| `POST` | [`/notifications/retry`](#retry-many-notifications) | Retry many dead-lettered or failed notifications at once | `200` |
| `GET` | [`/metrics`](#metrics) | Counts by status, and how long the oldest due notification has waited | `200` |
| `GET` | [`/health`](#health) | Whether the service and the database are working | `200`, or `503` |
| `POST` | [`/webhooks/mock`](#mock-webhook-receiver) | A demo receiver for webhook calls | `200` |

### The notification object

Most endpoints return a notification in this form:

```json
{
  "id": "3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c",
  "idempotencyKey": "welcome-user-123",
  "recipient": "user@example.com",
  "channel": "EMAIL",
  "priority": "HIGH",
  "status": "PENDING",
  "scheduledAt": "2026-09-25T09:01:00.000Z",
  "nextAttemptAt": "2026-09-25T09:01:00.000Z",
  "attemptCount": 0,
  "maxAttempts": 6,
  "lastError": null,
  "sentAt": null,
  "failedAt": null,
  "deadLetteredAt": null,
  "cancelledAt": null,
  "redriveCount": 0,
  "lastRedrivenAt": null,
  "createdAt": "2026-09-25T09:00:00.000Z",
  "updatedAt": "2026-09-25T09:00:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `id` | The notification's ID. Use it in the other endpoints |
| `status` | `PENDING` (waiting), `PROCESSING` (being sent), `SENT`, `FAILED` (can never be delivered), `DEAD_LETTERED` (kept failing) or `CANCELLED` |
| `scheduledAt` | When the notification was first due |
| `nextAttemptAt` | When it is next due. This moves forward after a failed attempt |
| `attemptCount` / `maxAttempts` | Delivery attempts made so far, and the most allowed (1 attempt and 5 retries) |
| `lastError` | The error from the most recent failed attempt, or `null` |
| `sentAt`, `failedAt`, `deadLetteredAt`, `cancelledAt` | When it reached that final status, or `null` |
| `redriveCount` / `lastRedrivenAt` | How many times an operator has retried it, and when |

The message content (`payload`) is never returned, and it is never written to the logs.

### Errors

Every error has the same form. `details` appears only when the request failed validation,
and it lists every problem at once:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [
    {
      "field": "channel",
      "errors": ["channel must be one of the following values: EMAIL, SMS, PUSH"]
    },
    {
      "field": "sendAt",
      "errors": ["Provide exactly one of sendAt or delaySeconds"]
    }
  ],
  "path": "/notifications",
  "requestId": "280d8632-55aa-4cfa-b884-51a117549d58"
}
```

| Code | Meaning |
| --- | --- |
| `400` | The request is invalid. The response explains why |
| `404` | No notification has that `id` |
| `409` | The action is not allowed in the notification's current status, or the idempotency key was already used for a different request |
| `500` | An unexpected error. The details are logged on the server, never returned |

Every response, including errors, has an `X-Request-ID` header. The same ID appears in the
logs, so a problem can be traced. You can also send your own `X-Request-ID`.

### Schedule a notification

`POST /notifications`

Send the notification after a delay:

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

Or at a set time:

```json
{
  "recipient": "+2348012345678",
  "channel": "SMS",
  "payload": { "body": "Your appointment is tomorrow at 9:00." },
  "priority": "NORMAL",
  "sendAt": "2026-12-01T08:00:00Z",
  "idempotencyKey": "appointment-reminder-42"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `recipient` | Yes | An email address, phone number or device token. Up to 320 characters |
| `channel` | Yes | `EMAIL`, `SMS` or `PUSH` |
| `payload` | Yes | A JSON object with the message content |
| `priority` | Yes | `HIGH`, `NORMAL` or `LOW` |
| `delaySeconds` | One of these two | Seconds from now: at least 1, and at most 365 days (31,536,000) |
| `sendAt` | One of these two | A date and time with a timezone, for example `2026-12-01T08:00:00Z`. Up to 365 days ahead |
| `idempotencyKey` | Yes | A unique key you choose for this notification. Up to 255 characters |

**Response `201 Created`:** the new notification (see [the notification object](#the-notification-object)).

**Sending the same request again** with the same key returns **`200 OK`** and the original
notification, with the header `Idempotent-Replayed: true`. No second notification is
created, so a client can safely retry after a timeout.

**Reusing a key for a different request** returns **`409 Conflict`**:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Idempotency key \"welcome-user-123\" was already used for a different notification request",
  "path": "/notifications",
  "requestId": "4e1c3ec0-fefc-4a23-8674-eb5908cab31e"
}
```

### Get a notification

`GET /notifications/{id}`

```bash
curl http://localhost:3000/notifications/1948de39-9858-4590-8610-9801d989dc59
```

**Response `200 OK`.** This notification failed 6 times and is in the dead-letter queue:

```json
{
  "id": "1948de39-9858-4590-8610-9801d989dc59",
  "idempotencyKey": "seed-dead-lettered",
  "recipient": "katherine@example.com",
  "channel": "SMS",
  "priority": "NORMAL",
  "status": "DEAD_LETTERED",
  "scheduledAt": "2026-09-25T07:52:56.690Z",
  "nextAttemptAt": "2026-09-25T07:52:56.690Z",
  "attemptCount": 6,
  "maxAttempts": 6,
  "lastError": "Simulated provider outage",
  "sentAt": null,
  "failedAt": null,
  "deadLetteredAt": "2026-09-25T07:52:56.690Z",
  "cancelledAt": null,
  "redriveCount": 0,
  "lastRedrivenAt": null,
  "createdAt": "2026-09-25T05:52:56.690Z",
  "updatedAt": "2026-09-25T07:52:56.690Z"
}
```

**Errors:** `404` if no notification has that ID, for example
`"message": "Notification 3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c not found"`. `400` if the
ID is not a valid UUID: `"message": "Validation failed (uuid is expected)"`.

### List notifications

`GET /notifications`

```bash
curl 'http://localhost:3000/notifications?status=DEAD_LETTERED&limit=20'
```

| Query parameter | Required | Rules |
| --- | --- | --- |
| `status` | No | Only notifications in this status. `DEAD_LETTERED` lists the dead-letter queue |
| `recipient` | No | Only this recipient's notifications (exact match) |
| `limit` | No | Page size, from 1 to 100. The default is 20 |
| `cursor` | No | The `nextCursor` from the previous page |

**Response `200 OK`.** Notifications are listed newest first:

```json
{
  "items": [
    { "id": "1948de39-9858-4590-8610-9801d989dc59", "status": "DEAD_LETTERED", "...": "..." }
  ],
  "nextCursor": null
}
```

Each item in `items` is a full [notification object](#the-notification-object).
`nextCursor` is `null` on the last page. Otherwise, pass it as `&cursor=...` to get the
next page.

### Cancel a notification

`DELETE /notifications/{id}`

```bash
curl -X DELETE http://localhost:3000/notifications/dd0763d1-762f-4ce6-aac0-74d5b7eda399
```

**Response `200 OK`:** the notification, now cancelled. It will never be sent:

```json
{
  "id": "dd0763d1-762f-4ce6-aac0-74d5b7eda399",
  "status": "CANCELLED",
  "cancelledAt": "2026-09-25T08:53:41.065Z",
  "...": "the other fields, as in the notification object"
}
```

Only a `PENDING` notification can be cancelled. Cancelling one that is already cancelled
returns it unchanged, so the call is safe to repeat. Once a worker has started sending it,
or it has finished, the answer is **`409 Conflict`**:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Notification 02022eeb-f68e-4ee8-aaca-0ac03b74cfe5 is SENT; only PENDING jobs can be cancelled",
  "path": "/notifications/02022eeb-f68e-4ee8-aaca-0ac03b74cfe5",
  "requestId": "546cb543-ff00-49ed-86ee-f2ec86b648b8"
}
```

### Retry one notification

`POST /notifications/{id}/retry`

```bash
curl -X POST http://localhost:3000/notifications/1948de39-9858-4590-8610-9801d989dc59/retry
```

**Response `200 OK`:** the notification is back in the queue, due now, with a fresh set of
6 attempts. `redriveCount` records the retry, and `lastError` is kept until the next
attempt:

```json
{
  "id": "1948de39-9858-4590-8610-9801d989dc59",
  "status": "PENDING",
  "nextAttemptAt": "2026-09-25T08:53:41.125Z",
  "attemptCount": 0,
  "maxAttempts": 6,
  "lastError": "Simulated provider outage",
  "deadLetteredAt": null,
  "redriveCount": 1,
  "lastRedrivenAt": "2026-09-25T08:53:41.125Z",
  "...": "the other fields, as in the notification object"
}
```

Only a `DEAD_LETTERED` or `FAILED` notification can be retried. Anything else returns
**`409 Conflict`**, for example
`"message": "Notification aab94e73-2114-4cfa-bf41-dc1132fc0a73 is PENDING; only DEAD_LETTERED or FAILED jobs can be retried"`.

A retried notification goes through the normal process again. If it keeps failing, it
returns to the dead-letter queue after 6 attempts.

### Retry many notifications

`POST /notifications/retry`

Retry the oldest 100 notifications in the dead-letter queue (the body is optional):

```bash
curl -X POST http://localhost:3000/notifications/retry
```

Or choose what to retry:

```bash
curl -X POST http://localhost:3000/notifications/retry \
  -H 'Content-Type: application/json' \
  -d '{ "status": "FAILED", "recipient": "user@example.com", "limit": 500 }'
```

| Field | Required | Rules |
| --- | --- | --- |
| `status` | No | `DEAD_LETTERED` (the default) or `FAILED` |
| `recipient` | No | Only this recipient's notifications |
| `limit` | No | How many to retry in this call, oldest first, from 1 to 1,000. The default is 100 |

**Response `200 OK`:**

```json
{
  "retried": 100,
  "remaining": 250
}
```

`retried` is how many notifications this call sent back to the queue. `remaining` is how
many still match. Repeat the call until `remaining` is `0`. Each notification is reset in
the same way as a single retry.

An invalid `status` or `limit` returns **`400 Bad Request`**, for example
`"status must be one of the following values: DEAD_LETTERED, FAILED"`.

### Metrics

`GET /metrics`

```bash
curl http://localhost:3000/metrics
```

**Response `200 OK`:**

```json
{
  "pending": 23,
  "processing": 0,
  "sent": 1,
  "failed": 0,
  "deadLettered": 0,
  "cancelled": 2,
  "queueLagSeconds": 44.548,
  "webhooks": {
    "pending": 0,
    "delivered": 4,
    "givenUp": 0
  }
}
```

| Field | Meaning |
| --- | --- |
| `pending` … `cancelled` | How many notifications are in each status |
| `queueLagSeconds` | How long the oldest due notification has waited to be picked up. If this keeps rising, the workers are not keeping up |
| `webhooks` | Webhook calls waiting to be sent, delivered, and given up after 10 failed attempts |

### Health

`GET /health`

```bash
curl http://localhost:3000/health
```

**Response `200 OK`** when the service and the database are working:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up", "responseTime": 1 } },
  "error": {},
  "details": { "database": { "status": "up", "responseTime": 1 } }
}
```

If the database does not answer within 1.5 seconds, the response is
**`503 Service Unavailable`**, with `"status": "error"`. Workers serve this endpoint too, on
their own port.

### Webhooks

When a notification reaches `SENT`, `FAILED` or `DEAD_LETTERED`, the service sends a
`POST` request to `WEBHOOK_URL` with this body:

```json
{
  "eventId": "7d9e2c41-5b3a-4f1e-9c8d-2a6b4e0f1c3d",
  "jobId": "02022eeb-f68e-4ee8-aaca-0ac03b74cfe5",
  "status": "SENT",
  "attemptCount": 1,
  "timestamp": "2026-09-25T09:00:01.000Z"
}
```

The same `eventId` is also sent in the `X-Webhook-Event-Id` header. If your server does not
answer with a `2xx` status, the call is retried with backoff, up to 10 attempts in total.
A webhook can occasionally arrive twice, so use `eventId` to ignore repeats.

#### Mock webhook receiver

`POST /webhooks/mock`

A demo receiver, so you can watch webhooks arrive without your own server. It is the
default `WEBHOOK_URL`. It accepts the body above.

**Response `200 OK`:**

```json
{
  "eventId": "7d9e2c41-5b3a-4f1e-9c8d-2a6b4e0f1c3d",
  "duplicate": false,
  "receivedCount": 1
}
```

If the same event arrives again, `duplicate` is `true` and `receivedCount` goes up.

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
