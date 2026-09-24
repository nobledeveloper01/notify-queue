# Notify Queue

A distributed, delayed notification queue built on PostgreSQL. Clients schedule a
notification for a time or after a delay; any number of worker processes claim due jobs
without ever handing one job to two workers, deliver them through a pluggable provider,
retry failures with exponential backoff, dead-letter what cannot be delivered, respect a
per-recipient rate limit, and report every final outcome to a webhook.

PostgreSQL is the only infrastructure: it is the queue, the lock manager, the rate-limit
store and the webhook outbox. The design is explained in [DESIGN.md](DESIGN.md).

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Requirements](#requirements)
- [Environment setup](#environment-setup)
- [Database setup](#database-setup)
- [Migrations](#migrations)
- [Seed](#seed)
- [Running the API](#running-the-api)
- [Running a worker](#running-a-worker)
- [Running multiple workers](#running-multiple-workers)
- [Docker](#docker)
- [Swagger](#swagger)
- [API examples](#api-examples)
- [Testing](#testing)
- [Concurrency testing](#concurrency-testing)
- [Retry behaviour](#retry-behaviour)
- [Rate limiting](#rate-limiting)
- [Exactly-once semantics](#exactly-once-semantics)
- [Known limitations](#known-limitations)
- [Scaling strategy](#scaling-strategy)

## Features

- **Scheduling** at an absolute time (`sendAt`, ISO 8601 with an offset) or after a delay
  (`delaySeconds`); exactly one of the two is required.
- **Idempotent API**: repeating a request with the same `idempotencyKey` and body returns
  the original job (200); reusing a key for a different body is rejected (409). Safe under
  concurrent duplicates, enforced by a unique constraint.
- **Distributed workers** that claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`, scale
  horizontally, and never hold a lock while talking to the outside world.
- **Priorities** (HIGH, NORMAL, LOW) honoured when claiming.
- **Bounded concurrency** per worker, and a cap on how much work one worker may hold.
- **Retries** with exponential backoff and jitter; **dead-lettering** once retries run out;
  permanent provider errors fail immediately.
- **Crash recovery**: a job whose worker died is returned to the queue after a visibility
  timeout. A fencing token stops the original worker from overwriting the new owner's result.
- **Idempotent delivery**: every attempt of a job uses the same delivery key, so a job
  recovered after its provider call succeeded is not sent twice.
- **Per-recipient rate limit** over a sliding window, shared by all workers through
  PostgreSQL. Waiting for the limit does not use up an attempt.
- **Webhooks** for SENT, FAILED and DEAD_LETTERED via a transactional outbox: delivered at
  least once, with retries, deduplicable by event ID.
- **Graceful shutdown**: workers stop claiming, finish running deliveries, and hand
  unstarted jobs straight back to the queue.
- **Operations**: `/health` (application and PostgreSQL), `/metrics` (queue depth, queue
  lag, webhook backlog), structured JSON logs with request IDs and worker fields, and
  notification payloads never logged.
- **OpenAPI** documentation at `/api/docs`.

## Architecture

```
                         ┌──────────────┐
    HTTP clients ──────▶ │     API      │  APP_ROLE=api
                         └──────┬───────┘
                                │ INSERT … ON CONFLICT (idempotency_key) DO NOTHING
                                ▼
                      ┌────────────────────┐
                      │     PostgreSQL     │  jobs · rate-limit reservations · webhook outbox
                      └────────────────────┘
                        ▲        ▲        ▲
      FOR UPDATE        │        │        │   token-fenced status updates
      SKIP LOCKED       │        │        │
                   ┌────┴───┐┌───┴────┐┌──┴─────┐
                   │ Worker ││ Worker ││ Worker │  APP_ROLE=worker, scaled horizontally
                   └───┬────┘└───┬────┘└───┬────┘
                       │         │         │
                       ▼         ▼         ▼
             Notification provider      Webhook endpoint
             (idempotent on delivery key)  (at-least-once, dedupe by eventId)
```

One image runs every role; `APP_ROLE` selects `api`, `worker` or `all` (both, for local
development).

Every feature follows the same layering:

```
Controller → DTO validation → Service → Repository → PostgreSQL
```

Controllers handle HTTP only, services hold the business rules, and repositories are the
only code that touches the database. The worker side follows the same rule:

```
WorkerScheduler → WorkerService → JobClaimService → NotificationJobRepository
                                → JobProcessorService → RateLimitService
                                                      → DeliveryService → NotificationProvider
                                                      → RetryService
```

## Folder structure

```
src/
├── main.ts, app.module.ts, app.setup.ts
├── config/           validated environment, typed configuration
├── common/           enums, constants, DTOs, exception filter, request-id and request-logging
│                     middleware, validation pipe, pino logger, idempotency fingerprint
├── database/         connection options, migrations, seed runner, raw-query helper
├── notifications/    API: controller, DTOs, service, repository, entity, state machine
├── workers/          scheduler, worker loop, claiming, processing, stale-claim recovery
├── delivery/         provider interface, mock provider, delivery service with timeout
├── retry/            backoff policy, failure handling
├── rate-limit/       sliding-window limiter and its repository
├── webhooks/         outbox dispatcher, demo receiver
├── metrics/          SQL-aggregated queue metrics
└── health/           terminus health check
tests/
├── unit/             pure logic: policies, validation, service rules, logger
├── integration/      real PostgreSQL: repository, HTTP API, worker, webhooks, operations
├── concurrency/      real PostgreSQL races: claiming, idempotency, rate limit, webhook dispatch
└── support/          test app factory, deterministic providers, fixtures
```

## Requirements

- Node.js 22.13 or newer (the Docker image uses Node 24)
- npm
- Docker with Compose v2 (for PostgreSQL, or for the whole stack)

## Environment setup

```bash
npm ci
cp .env.example .env
```

`.env.example` documents every variable. The defaults point the app at the Compose
PostgreSQL on host port **5434** (chosen to avoid clashing with a local PostgreSQL on 5432).
All variables are validated at startup; a bad value stops the process with a list of
every problem.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ROLE` | `all` | `api`, `worker`, or `all` |
| `PORT` | `3000` | HTTP port (a worker serves only `/health` and `/metrics` on it) |
| `LOG_LEVEL` | `info` | pino level; `NODE_ENV=development` prints human-readable logs |
| `DATABASE_*` | see file | PostgreSQL connection; `DATABASE_POOL_MAX` sizes the pool |
| `WORKER_ID` | random UUID | Stable name for a worker in logs and claims |
| `WORKER_CONCURRENCY` | `10` | Deliveries one worker runs at once |
| `WORKER_BATCH_SIZE` | `100` | Most claimed-but-unfinished jobs one worker may hold |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Wait between polls when the queue is idle |
| `WORKER_RECOVERY_INTERVAL_MS` | `30000` | How often stale claims are recovered |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `30000` | How long shutdown waits for running deliveries |
| `JOB_VISIBILITY_TIMEOUT_SECONDS` | `300` | A claim older than this is presumed dead |
| `PROVIDER_TIMEOUT_MS` | `10000` | Cap on one provider call; must be below the visibility timeout |
| `MAX_RETRIES` | `5` | Retries after the first attempt (6 attempts in total) |
| `BASE_RETRY_DELAY_MS` / `MAX_RETRY_DELAY_MS` | `1000` / `60000` | Backoff range |
| `MOCK_FAILURE_RATE` | `0.2` | Chance the mock provider fails transiently |
| `MOCK_LATENCY_MS` | `50` | Mock provider latency |
| `RATE_LIMIT_MAX_NOTIFICATIONS` / `RATE_LIMIT_WINDOW_SECONDS` | `10` / `3600` | Per-recipient limit |
| `WEBHOOK_URL` | demo receiver | Status-change webhook target; empty disables dispatch |
| `WEBHOOK_TIMEOUT_MS` / `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_POLL_INTERVAL_MS` | `5000` / `10` / `1000` | Webhook delivery |

## Database setup

```bash
docker compose up -d postgres
```

This starts PostgreSQL 17 with a health check. On first start it also creates
`notify_queue_test`, the database the test suites use. Tests refuse to run against any
database whose name does not end in `_test`.

## Migrations

The schema is owned by hand-written migrations; `synchronize` is off everywhere.

```bash
npm run migration:run      # apply pending migrations
npm run migration:show     # list applied and pending
npm run migration:revert   # undo the most recent one
```

Each command builds first, then runs the TypeORM CLI against the compiled
`dist/database/data-source.js` with the same validated configuration the app uses.

## Seed

```bash
npm run seed
```

Loads [`seed.sql`](seed.sql): an immediate job, a delayed job, one job at each priority,
twelve jobs for one recipient (over the default limit of ten, so the rate limit shows),
a job part-way through its retries, a job that will fail permanently, and one historical
job in each final state. It is idempotent: running it again inserts nothing new.

## Running the API

```bash
npm run build
npm run start:api          # APP_ROLE=api
```

or `npm run start:dev` for watch mode with the API and a worker in one process.

## Running a worker

```bash
npm run start:worker       # APP_ROLE=worker
```

A worker polls for due jobs, delivers them, recovers stale claims and dispatches webhooks.
Over HTTP it answers only `/health` and `/metrics` (anything else is a 404). On SIGTERM it
stops claiming, returns unstarted jobs to the queue, and waits up to
`WORKER_SHUTDOWN_TIMEOUT_MS` for running deliveries.

## Running multiple workers

Workers need nothing but the database, so start as many as you like, each with its own
port and (optionally) its own name:

```bash
PORT=3001 WORKER_ID=worker-1 npm run start:worker
PORT=3002 WORKER_ID=worker-2 npm run start:worker
PORT=3003 WORKER_ID=worker-3 npm run start:worker
```

## Docker

```bash
docker compose up --build                   # PostgreSQL, one API, one worker
docker compose up --build --scale worker=3  # three workers
docker compose --profile seed run --rm seed # load the demo data
```

The stack runs a one-shot `migrate` service first; the API and workers start only after it
succeeds, so replicas never race to apply the same migration. Containers run as a non-root
user under an init process, so `docker compose stop` delivers SIGTERM and workers drain
cleanly (their grace period is longer than the drain timeout). Webhooks are pointed at the
API's demo receiver.

If port 3000 is taken on your machine: `API_HOST_PORT=3100 docker compose up --build`.

## Swagger

Interactive documentation: **http://localhost:3000/api/docs**
(OpenAPI JSON at `/api/docs-json`), served by API instances (`APP_ROLE=api` or `all`).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/notifications` | Schedule a notification |
| `GET` | `/notifications/:id` | A job's status and history |
| `GET` | `/metrics` | Queue depth, queue lag, webhook backlog |
| `GET` | `/health` | Application and PostgreSQL health |
| `POST` | `/webhooks/mock` | Demo webhook receiver |

## API examples

Schedule a notification in 60 seconds:

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

`201 Created`:

```json
{
  "id": "3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c",
  "idempotencyKey": "welcome-user-123",
  "recipient": "user@example.com",
  "channel": "EMAIL",
  "priority": "HIGH",
  "status": "PENDING",
  "scheduledAt": "2026-09-24T12:01:00.000Z",
  "nextAttemptAt": "2026-09-24T12:01:00.000Z",
  "attemptCount": 0,
  "maxAttempts": 6,
  "lastError": null,
  "sentAt": null,
  "failedAt": null,
  "deadLetteredAt": null,
  "createdAt": "2026-09-24T12:00:00.000Z",
  "updatedAt": "2026-09-24T12:00:00.000Z"
}
```

Sending the same request again returns `200 OK` with the same job and the header
`Idempotent-Replayed: true`. The same key with a different body returns `409 Conflict`.

Schedule for an absolute time instead:

```bash
curl -s -X POST http://localhost:3000/notifications \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"+2348012345678","channel":"SMS","payload":{"body":"Your code is 4829"},
       "priority":"NORMAL","sendAt":"2026-09-27T12:00:00Z","idempotencyKey":"otp-4829"}'
```

Check on it, and look at the queue:

```bash
curl -s http://localhost:3000/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c
curl -s http://localhost:3000/metrics
curl -s http://localhost:3000/health
```

Every error has the same shape, and every response carries an `X-Request-ID` (yours, if
you sent one):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [{ "field": "sendAt", "errors": ["Provide exactly one of sendAt or delaySeconds"] }],
  "path": "/notifications",
  "requestId": "5b0e8f9c-7a51-4e0a-b4c9-2f1d3e6a7b8c"
}
```

## Testing

The integration and concurrency suites run against real PostgreSQL (the
`notify_queue_test` database), so start it first:

```bash
docker compose up -d postgres
npm test                  # everything
npm run test:unit         # no database needed
npm run test:integration
npm run test:concurrency
npm run lint
npm run typecheck
```

Tests never depend on chance. Test providers (`AlwaysSuccessProvider`, `AlwaysFailProvider`,
`FailNTimesProvider`, `RecordingProvider`, plus hanging and throwing ones) replace the mock
provider, and randomness (jitter, simulated failures) is injected so it can be pinned. The
test suites share one database, so Jest runs files one at a time; the concurrency inside
each test is real.

## Concurrency testing

`tests/concurrency/` holds the races that matter, each against real PostgreSQL:

| Test | Scenario | Checks |
| --- | --- | --- |
| `duplicate-delivery` | 1 job, 10 complete worker apps polling at once; 300 jobs across 10 workers | Provider called exactly once per job; every job SENT on its first attempt |
| `concurrent-idempotency` | 25 simultaneous identical POSTs; two different bodies racing for one key; 8 connection pools inserting at once | One job; exactly one 201; losers of a body race get 409 |
| `concurrent-rate-limit` | 20 simultaneous admissions for one recipient; 10 workers competing over 40 jobs | Exactly N admitted; no sliding window ever exceeds N |
| `webhook-dispatch` | 6 dispatchers claiming 60 events at once | Each event POSTed once |

Each suite was also checked against a deliberately broken implementation (no
`SKIP LOCKED`, no advisory lock, no `ON CONFLICT`, no fencing token) to confirm it fails
when the guarantee is removed. A control test shows a naive read-then-update claim handing
one job to several workers.

## Retry behaviour

A failed attempt is classified by the provider:

- **Permanent** (for example, a rejected recipient): the job becomes `FAILED` at once.
- **Retryable** (outage, timeout, unexpected error): the job returns to `PENDING`, due after

  ```
  delay = min(BASE_RETRY_DELAY_MS × 2^(attempt−1), MAX_RETRY_DELAY_MS)
  then jittered uniformly between half and all of that
  ```

  With the defaults: about 0.5–1 s, 1–2 s, 2–4 s, 4–8 s, 8–16 s.
- When the last attempt (`MAX_RETRIES + 1`) fails, the job becomes `DEAD_LETTERED` and is
  never retried automatically.

Attempts are counted when a job is claimed, so a job that crashes every worker that picks
it up still runs out of attempts. Anything that stops a job before it reaches the provider
(waiting for the rate limit, a shutdown hand-back, an error before sending) refunds the
attempt.

One special case: if the claim on a job's **final** attempt expires, the worker may have
died after the provider accepted the notification. Rather than dead-letter a notification
that may have gone out, recovery grants one extra attempt, which resends with the same
delivery key and settles it. Only if that attempt's claim expires too is the job
dead-lettered.

The mock provider fails transiently at `MOCK_FAILURE_RATE` and rejects any recipient
starting with `invalid` permanently, so every path can be seen without code changes.

## Rate limiting

Each recipient may receive at most `RATE_LIMIT_MAX_NOTIFICATIONS` in any
`RATE_LIMIT_WINDOW_SECONDS`, measured as a **sliding** window: there is no boundary at
which twice the limit can slip through, as there would be with fixed windows.

Admissions are recorded in `rate_limit_reservations` inside a short transaction that holds
a PostgreSQL advisory lock on the recipient, so workers checking the same recipient take
turns and cannot both see "one slot left". A job over the limit is not failed: it returns
to `PENDING`, due exactly when the oldest admission leaves the window, with its attempt
refunded. A retried or recovered job keeps the slot it already had.

## Exactly-once semantics

The system does **not** claim that PostgreSQL delivers exactly once. It provides:

1. **Exclusive claiming**: a job is held by at most one worker at a time
   (`FOR UPDATE SKIP LOCKED`, plus a per-claim fencing token).
2. **Idempotent delivery**: every attempt at a job sends the same delivery key (the job ID).

Together these give **one logical delivery per job**, provided the provider honours the
delivery key. The window they close is this one:

```
Worker A: claim → send(deliveryKey) → provider accepts → ✗ crash before recording SENT
Database: job still PROCESSING
Later:    lease expires → job recovered → Worker B: send(same deliveryKey)
Provider: "already delivered" → no second notification → Worker B records SENT
```

Without the delivery key, that sequence sends the notification twice, and no queue design
can prevent it on its own. The same resend also settles a crash on a job's *final*
attempt: instead of being dead-lettered with its outcome unknown, the job gets one
reconciliation attempt. The mock provider keeps its record of accepted keys in
PostgreSQL, shared by every worker, as a real provider would; the integration suite
reproduces exactly this crash.

Webhooks are **at least once**: each carries a stable `eventId` (also in the
`X-Webhook-Event-Id` header), and receivers should ignore IDs they have already processed,
as the demo receiver does.

## Known limitations

- **The provider is a mock.** A real provider needs to support idempotency keys (most
  email and SMS APIs do) for the delivery guarantee to hold end to end.
- **Rate-limited backlogs churn.** Claiming does not know about rate limits, so a large
  backlog for one busy recipient is claimed and deferred each time a slot frees. It is
  correct but wasteful at scale (see DESIGN.md for the fix).
- **Rate limits count admissions**, not successful deliveries: an attempt that then fails
  still used its slot.
- **Batch size trades fairness for throughput.** With the default batch of 100, the first
  worker to poll during a burst can claim up to 100 jobs while others find little. Lower
  `WORKER_BATCH_SIZE` spreads bursts more evenly.
- **Webhooks are not signed.** Production would add an HMAC signature header.
- **No authentication** on the API; it is out of scope for the assessment.
- **Priority is not preemptive**: a HIGH job created after a worker's batch was claimed
  waits for that worker's next poll.

## Scaling strategy

The short version: add workers until PostgreSQL becomes the constraint, then shrink what
each worker asks of it, and only then reach for a dedicated broker. DESIGN.md walks
through it from 1 to 1,000 workers and millions of jobs.

- **Workers** are stateless and scale horizontally; `SKIP LOCKED` keeps them from
  contending over rows.
- **Batch claiming** turns N jobs into one query and one transaction.
- **Partial indexes** keep the claim query touching only pending rows, however large the
  history grows.
- **Connection pooling** (PgBouncer in transaction mode) becomes necessary before workers
  number in the hundreds.
- **Partitioning** and archiving of finished jobs keep the hot table small.
- **Queue sharding** or an external broker (SQS, RabbitMQ, Kafka) becomes worthwhile when
  a single primary can no longer absorb the write rate, at a cost in operational
  complexity and in the transactional guarantees PostgreSQL gives for free.
