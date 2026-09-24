# Notify Queue: Technical Design

This is the engineering companion to [DESIGN.md](../DESIGN.md), which explains the same
system in plain English. This document covers how Notify Queue works in technical detail
and why it is built this way. The [README](../README.md) explains how to run it.

## Contents

1. [Architecture](#1-architecture)
2. [Requirements](#2-requirements)
3. [Component responsibilities](#3-component-responsibilities)
4. [Database design](#4-database-design)
5. [Repository architecture](#5-repository-architecture)
6. [Job lifecycle](#6-job-lifecycle)
7. [Distributed job claiming](#7-distributed-job-claiming)
8. [PostgreSQL locking](#8-postgresql-locking)
9. [Idempotency](#9-idempotency)
10. [Exactly-once semantics](#10-exactly-once-semantics)
11. [Retry and backoff](#11-retry-and-backoff)
12. [Dead-letter handling](#12-dead-letter-handling)
13. [Rate limiting](#13-rate-limiting)
14. [Webhooks](#14-webhooks)
15. [Worker failure recovery](#15-worker-failure-recovery)
16. [Failure matrix](#16-failure-matrix)
17. [Observability](#17-observability)
18. [Security](#18-security)
19. [Scalability](#19-scalability)
20. [Bottlenecks](#20-bottlenecks)
21. [Trade-offs](#21-trade-offs)
22. [Future improvements](#22-future-improvements)
23. [Design questions, answered](#23-design-questions-answered)
24. [Simplifying assumptions](#24-simplifying-assumptions)

---

## 1. Architecture

Notify Queue is a single NestJS codebase deployed as two roles against one PostgreSQL
database:

- **API** (`APP_ROLE=api`): validates and records scheduling requests. It never delivers
  anything.
- **Worker** (`APP_ROLE=worker`): claims due jobs, delivers them, records outcomes,
  recovers abandoned work and dispatches webhooks. Any number can run. Over HTTP it
  answers only `/health` and `/metrics`; any other path is a 404.

```
                ┌──────────┐
   clients ───▶ │   API    │
                └────┬─────┘
                     ▼
              ┌─────────────┐
              │ PostgreSQL  │  notification_jobs, rate_limit_reservations, webhook_events
              └─────────────┘
               ▲     ▲     ▲
           ┌───┴─┐┌──┴──┐┌─┴───┐
           │ W1  ││ W2  ││ W3  │ ──▶ notification provider, webhook endpoint
           └─────┘└─────┘└─────┘
```

PostgreSQL is deliberately the only shared component. It is the queue (a table), the
coordination mechanism (row locks and advisory locks), the rate-limit store and the
webhook outbox. Every guarantee below is a PostgreSQL guarantee: transactions, row locks,
`SKIP LOCKED`, unique constraints and check constraints. Workers hold no state that
another worker needs.

Inside the codebase the layering is strict:

```
Controller → DTO → Service → Repository → PostgreSQL
```

- **Controllers** translate HTTP: route, validate the DTO, call one service method, map
  the status code. No business rules, no queries.
- **Services** hold the rules: scheduling semantics, idempotency conflict detection,
  retry decisions, rate-limit admission.
- **Repositories** are the only code that issues SQL. They expose intention-revealing
  methods (`claimDueJobs`, `markSent`, `recoverStaleClaims`), not generic CRUD.
- **Entities and migrations** describe storage. Migrations own the schema, and TypeORM's
  `synchronize` is off.

## 2. Requirements

**Functional**

- Schedule a notification for an absolute time or after a relative delay.
- Deliver it at or after that time, highest priority first among due jobs.
- Retry transient failures with exponential backoff; stop after a bounded number of
  attempts (dead letter); do not retry permanent failures.
- Limit how many notifications one recipient receives per time window.
- Report each job's final outcome to a webhook.
- Expose job status, health and queue metrics.

**Non-functional**

- **Workers scale horizontally** with no coordination beyond the database.
- **No job is delivered twice**, including across worker crashes, provided the provider
  honours idempotency keys (section 10 is precise about this).
- **No lost work**: a crash at any point leaves every job recoverable.
- **Duplicate API requests are harmless.**
- **A slow or failing provider or webhook endpoint cannot stall the database** or crash
  a worker.
- **Invariants live in the database**, so a bug in one code path cannot corrupt state.

## 3. Component responsibilities

| Component | Responsibility |
| --- | --- |
| `NotificationsController` | Schedule, get, list, cancel and redrive; 201 vs 200 on replay |
| `NotificationsService` | Resolve the schedule, fingerprint the request, detect key reuse (409); cancel and redrive rules (404, 409, idempotent cancel, audited redrive); cursor decoding |
| `NotificationJobRepository` | Every read and write of `notification_jobs`, including claiming, fenced completion, recovery and the outbox insert |
| `job-state-machine.ts` | The legal status transitions; repositories derive their `WHERE status IN (…)` guards from it |
| `WorkerScheduler` | Drives the poll loop, the recovery timer and the webhook timer; starts only when the role is not `api`; drains on shutdown |
| `WorkerService` | Claims up to the free capacity, runs at most `WORKER_CONCURRENCY` deliveries, releases unstarted jobs on shutdown |
| `JobClaimService` | Claims, starts (lease renewal) and releases under this worker's ID |
| `JobProcessorService` | One attempt: start fence → rate-limit admission → delivery → record the outcome; refunds the attempt if it fails before the provider call |
| `DeliveryService` | Fixes the delivery key, enforces `PROVIDER_TIMEOUT_MS`, turns provider exceptions into retryable failures |
| `NotificationProvider` (interface) | The seam for a real provider; `MockNotificationProvider` by default |
| `RetryPolicyService` | Pure policy: backoff delay, and retry vs dead-letter vs fail |
| `RetryService` | Applies the policy and records the result |
| `RateLimitService` / `RecipientRateLimitRepository` | Sliding-window admission under a per-recipient lock |
| `WorkerRecoveryService` | Requeues or dead-letters expired claims; prunes old reservations |
| `WebhookService` / `WebhookEventRepository` | Claims due outbox events, POSTs them, retries, gives up |
| `MockWebhookReceiverService` | Demo receiver that deduplicates by event ID |
| `MetricsService` / `MetricsRepository` | SQL-aggregated counts, queue lag, webhook backlog |
| `HttpExceptionFilter`, `RequestIdMiddleware`, `RequestLoggingMiddleware`, `RoleRoutesMiddleware` | One error shape, correlation IDs, one log line per request, worker instances limited to `/health` and `/metrics` |

## 4. Database design

### `notification_jobs`

| Column | Notes |
| --- | --- |
| `id` | `uuid`, also the provider delivery key |
| `idempotency_key` | Unique; the client's deduplication key |
| `request_fingerprint` | SHA-256 of the canonical creating request; detects key reuse. NULL for rows created before it existed |
| `recipient`, `channel`, `payload` | `payload` is `jsonb` and is never logged or returned by the API |
| `reconciliation_granted` | Set once, when recovery grants an extra attempt to a job whose final attempt's claim expired (section 15) |
| `priority` | `smallint` (HIGH=3, NORMAL=2, LOW=1), so `ORDER BY priority DESC` means urgency |
| `status` | PENDING, PROCESSING, SENT, FAILED, DEAD_LETTERED, CANCELLED |
| `scheduled_at`, `next_attempt_at` | First due time; next due time (moves on retry or rate-limit deferral) |
| `attempt_count`, `max_attempts` | Attempts started; the cap (`MAX_RETRIES + 1`) |
| `locked_by`, `locked_at`, `claim_token` | The current claim: owner, lease start, fencing token |
| `last_error`, `sent_at`, `failed_at`, `dead_lettered_at`, `cancelled_at` | Outcome details |
| `redrive_count`, `last_redriven_at` | How many times an operator has retried the job, and when (the audit trail for redrives) |
| `created_at`, `updated_at` | `timestamptz` throughout |

**Constraints.** The application relies on these, so the database enforces them:

- `UNIQUE (idempotency_key)`: two requests can never create two jobs.
- `CHECK` on `channel`, `priority` and `status` values.
- `CHECK (attempt_count BETWEEN 0 AND max_attempts)`.
- `CHECK ((status = 'PROCESSING') = (claim_token, locked_by, locked_at all NOT NULL))`:
  a job holds a claim exactly when it is PROCESSING. An orphaned PROCESSING row, or a
  PENDING row that still names an owner, cannot exist.
- `CHECK` that SENT, FAILED, DEAD_LETTERED and CANCELLED each carry their timestamp.
- `CHECK` that `redrive_count` and `last_redriven_at` agree (both zero/NULL, or both set).

**Indexes.** Partial indexes cover only the rows each hot query reads:

| Index | Serves |
| --- | --- |
| `(priority DESC, next_attempt_at, created_at) WHERE status = 'PENDING'` | The claim query, in its exact `ORDER BY`, so PostgreSQL walks the index and stops after `LIMIT` rows, with no sort |
| `(locked_at) WHERE status = 'PROCESSING'` | Stale-claim recovery |
| `(recipient, created_at)` | Listing a recipient's jobs (`GET /notifications?recipient=…`) |
| `(status, created_at DESC, id DESC)` | Listing by status, e.g. the dead-letter queue (`?status=DEAD_LETTERED`); the page cursor becomes part of the index condition |
| `(created_at DESC, id DESC)` | Listing everything, newest first |

A common alternative is composite indexes that start with `status`, such as
`(status, next_attempt_at, priority)` and `(status, locked_at)`. Partial indexes do the
same job at a fraction of the size: in a mature system almost every row is SENT, and those
rows are not in the index at all. The claim index's column order also matches the
`ORDER BY` exactly, which a status-first composite cannot do when the filter is a range on
`next_attempt_at`. `EXPLAIN` confirms an index scan with no sort step.

### Supporting tables

| Table | Purpose |
| --- | --- |
| `rate_limit_reservations` | One row per job admitted for delivery: `(job_id PK, recipient, reserved_at)`, indexed `(recipient, reserved_at)` |
| `webhook_events` | The outbox: one row per terminal status change, with dispatch attempts, next attempt, delivered/given-up timestamps; `UNIQUE (job_id, status, redrive_count)`, so a redriven job's second terminal event does not collide with its first |
| `mock_provider_deliveries` | The mock provider's own record of accepted delivery keys; stands in for a real provider's store and would not exist in production |
| `mock_webhook_receipts` | The demo receiver's record of event IDs, with a count of redeliveries |

Seven migrations build this schema, each adding one feature. None was ever edited after
being applied: when something was needed later (`request_fingerprint`,
`reconciliation_granted`, cancellation and redrive), it came as a new migration.

## 5. Repository architecture

Repositories are the only layer that knows SQL exists. That buys four things:

- **Reviewability.** Every locking decision and every transaction boundary is in a
  handful of files, next to the comment that justifies it.
- **Testability.** Services are unit-tested against simple fakes; repositories are
  integration-tested against real PostgreSQL.
- **Invariants in one place.** For example, every way a claimed job can finish goes
  through one private method, `completeClaim`, which applies the fencing check, derives
  the allowed source statuses from the state machine, and writes the webhook event.
- **Meaningful methods.** Callers say what they mean: `claimDueJobs`, `markSent`,
  `scheduleRetry`, `deferRateLimited`, `releaseClaim`, `recoverStaleClaims`.

Two implementation notes:

- The hot paths (claiming, recovery, idempotent insert) are written as explicit SQL,
  because that SQL *is* the design and should be read directly. Simple lookups use
  TypeORM.
- TypeORM's `query()` returns rows for SELECT and INSERT, but `[rows, count]` for UPDATE
  and DELETE. Every data-changing query that reads rows back therefore goes through one
  helper (`runQuery`), which always returns `{ records, affected }`, so no caller has to
  remember the difference.

## 6. Job lifecycle

```
             claim (attempt + 1)
   PENDING ─────────────────────▶ PROCESSING ─────▶ SENT
      ▲                              │  ├──────────▶ FAILED          permanent error
      │                              │  └──────────▶ DEAD_LETTERED   retries exhausted
      └──────────────────────────────┘
        retry (backoff)
        rate limited (attempt refunded)
        released at shutdown (attempt refunded)
        claim expired (recovery)

   Operator actions (API calls, never automatic):
   PENDING ──────── DELETE /notifications/:id ─────────▶ CANCELLED
   DEAD_LETTERED ┐
   FAILED ───────┴─ POST /notifications/:id/retry ─────▶ PENDING  (fresh attempt budget)
```

- Terminal states (SENT, FAILED, DEAD_LETTERED, CANCELLED) have no *automatic* outgoing
  transitions. Nothing the system does on its own moves a SENT job back to PROCESSING or
  retries a DEAD_LETTERED job.
- The automatic transitions live in `job-state-machine.ts`. Repositories derive each
  update's `WHERE status IN (…)` from it rather than repeating the rules, so the database
  refuses an illegal transition even if the calling code is wrong.
- Operator actions live in a separate table in the same file (`OPERATOR_TRANSITIONS`).
  Widening the automatic table instead would widen the guard on every worker update.

### Cancelling

`DELETE /notifications/:id` is one conditional update:
`… SET status = 'CANCELLED' WHERE id = $1 AND status = 'PENDING'`. It races safely with
claiming. If a worker's claim transaction holds the row, the cancel waits for it,
re-checks the condition, finds PROCESSING, and changes nothing. The client gets a 409, and
the job is delivered. Each job therefore ends up either cancelled and never claimed, or
claimed and not cancelled. `tests/concurrency/cancel-vs-claim.spec.ts` runs 200 such races
at once and checks every job. Cancelling an already cancelled job returns it unchanged,
so the call is safe to retry. Cancellation is a client action and emits no webhook.

### Listing

`GET /notifications?status=&recipient=&limit=&cursor=` returns jobs newest first, using
keyset pagination on `(created_at, id)`:

- **Every page is an index range scan** starting where the last one ended, so page 1,000
  costs the same as page 1. With `OFFSET`, the database would read and discard every
  earlier row.
- **The cursor is opaque** (base64url) and carries PostgreSQL's exact `created_at` text.
  A JavaScript `Date` would drop microseconds, and jobs created in the same millisecond
  would be skipped or repeated. A test pages through 23 jobs that share one timestamp.

## 7. Distributed job claiming

Each worker polls in a loop:

```
poll ──▶ claim up to (batch size − jobs already held) ──▶ run ≤ WORKER_CONCURRENCY at once
  ▲                                                            │
  └──── immediately if the poll filled its request, ◀──────────┘
        otherwise after WORKER_POLL_INTERVAL_MS
```

- **Claiming** is one short transaction (section 8). The claimed batch goes into an
  in-memory queue; up to `WORKER_CONCURRENCY` deliveries run at once, and each finished
  one starts the next.
- **Starting a job renews its lease.** Just before a queued job starts, the worker
  refreshes `locked_at` with a token-fenced update. Time spent waiting in the local queue
  therefore does not eat into the lease. If the claim was lost while the job waited (it
  expired and another worker took it), the update matches nothing and the job is skipped
  instead of being sent a second time.
- **A worker never holds more than `WORKER_BATCH_SIZE`** claimed-but-unfinished jobs.
  Their leases are ticking, so hoarding them would delay work other workers could be
  doing.
- **The loop never overlaps itself.** The next poll is scheduled only after the previous
  one completes (a self-rescheduling timeout, not a fixed interval). A poll that filled
  its whole request suggests a backlog, so the next poll runs immediately; otherwise the
  worker waits. An idle worker costs one indexed query per interval.

### Why `SKIP LOCKED`

Suppose three workers poll at the same instant. Without row locking:

```
A reads Job 1    B reads Job 1    C reads Job 1    → all three deliver Job 1
```

With plain `FOR UPDATE`, B and C wait for A's lock, then find Job 1 taken: correct, but
the workers serialise behind each other. With `FOR UPDATE SKIP LOCKED`, each worker
passes over rows another transaction has locked and takes the next ones:

```
A → Job 1        B → Job 2        C → Job 3
```

Workers get disjoint batches with no waiting, so adding workers adds throughput. A
control test in `tests/concurrency/duplicate-delivery.spec.ts` shows the naive
read-then-update version handing one job to several workers.

## 8. PostgreSQL locking

### The claim transaction

```sql
BEGIN;

SELECT id
  FROM notification_jobs
 WHERE status = 'PENDING'
   AND next_attempt_at <= now()
   AND attempt_count < max_attempts
 ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
 LIMIT $batch
   FOR UPDATE SKIP LOCKED;

UPDATE notification_jobs
   SET status = 'PROCESSING',
       locked_by = $workerId,
       locked_at = now(),
       claim_token = $freshUuid,
       attempt_count = attempt_count + 1
 WHERE id = ANY($ids);

COMMIT;
```

The rows are locked from the `SELECT` until `COMMIT`, so no other transaction can claim
them in between, and the transaction lasts milliseconds.

### The transaction boundary

The one rule that matters most: **no lock and no transaction is ever held across a
network call.**

```
Never:                               Instead:

BEGIN                                BEGIN
  SELECT … FOR UPDATE                  SELECT … FOR UPDATE SKIP LOCKED
  send to provider   ← seconds         UPDATE → PROCESSING
  UPDATE → SENT                      COMMIT                 ← locks released
COMMIT                               send to provider       ← no transaction open
                                     BEGIN
                                       UPDATE → SENT  (token-fenced)
                                       INSERT webhook event
                                     COMMIT
```

Holding the lock across the provider call would tie up a connection and a row lock for
the length of the slowest provider response, turning a provider slowdown into database
exhaustion. It also would not help correctness: if the worker died mid-call, the rollback
would unlock the row with no record that anything was sent. The claim, not the lock, is
what marks the job as taken, and the claim is durable.

### Fencing

Releasing the lock at `COMMIT` means ownership after that point is a *lease*, represented
by `claim_token`. Starting the job (`startAttempt`) and every way it can finish
(`markSent`, `markFailed`, `markDeadLettered`, `scheduleRetry`, `deferRateLimited`,
`releaseClaim`) is one update:

```sql
UPDATE notification_jobs SET status = $to, …
 WHERE id = $id AND claim_token = $myToken AND status IN (…allowed sources…)
```

If the lease expired and the job was reclaimed, the token no longer matches, the update
changes zero rows, and the late worker learns it lost the claim (`job.claim_lost` in the
logs) instead of overwriting the new owner's result.

### Clocks

Every time that orders or expires work (`now()`, lease cutoffs, retry times, rate-limit
windows, delays) is computed by PostgreSQL. Workers on machines with skewed clocks
therefore still agree on what is due and what is stale.

## 9. Idempotency

There are two separate problems, with two separate mechanisms.

**Duplicate client requests.** The client supplies `idempotencyKey`, and the insert is:

```sql
INSERT INTO notification_jobs (…) SELECT …
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id
```

- **The unique constraint is the arbiter.** When two requests race, the second waits for
  the first to commit, then inserts nothing, and the service reads back the existing
  job. There is no read-then-write window and no unique-violation error to catch.
- **Key reuse is detected.** The service stores a SHA-256 fingerprint of the canonical
  request: sorted keys, and times normalised to UTC, so `09:30+01:00` equals `08:30Z`.
  - Same key, same fingerprint: `200 OK` with the original job and `Idempotent-Replayed: true`.
  - Same key, different fingerprint: `409 Conflict`. Silently returning a different
    notification than the one requested would hide a client bug.
- **Tested concurrently:** 25 simultaneous identical requests create one job, and when two
  different bodies race for one key, exactly one wins and every request with the other
  body gets 409.

**Duplicate side effects.** This is covered in the next section, and it is a different
key: the delivery key, which is the job ID.

## 10. Exactly-once semantics

Being precise here matters more than anywhere else.

**What the system provides:**

1. **Exclusive claiming.** At most one worker holds a job at a time (`SKIP LOCKED` plus the
   fencing token).
2. **Idempotent delivery.** Every attempt at a job sends the same delivery key.

**What that adds up to:** one *logical* delivery per job, when the provider deduplicates
on the delivery key. It is **not** "PostgreSQL delivers exactly once". No database can
make an external side effect happen exactly once on its own. The gap is this window:

```
Worker A: claim ─▶ send(key) ─▶ provider delivers ─▶ ✗ crash before UPDATE → SENT
Database: job is still PROCESSING, and nothing records that the send happened
```

After `JOB_VISIBILITY_TIMEOUT_SECONDS`, recovery returns the job to PENDING and another
worker sends it again. What prevents a second notification is the provider recognising
the key:

```
Worker B: send(same key) ─▶ provider: "already delivered" ─▶ Worker B records SENT
```

So the delivery guarantee is **at-least-once attempts, deduplicated to one delivery by
the provider**. The mock provider keeps its record of accepted keys in PostgreSQL, shared
by all workers as a real provider's is. `worker.integration-spec.ts` reproduces this
exact crash and asserts one delivery. With a provider that does not support idempotency
keys, the honest guarantee is at-least-once, and the crash window above is where
duplicates come from.

The same reasoning applies to the other side effect, webhooks (section 14): at-least-once,
deduplicable by event ID.

## 11. Retry and backoff

`RetryPolicyService` is pure (it performs no I/O), so it is fully covered by unit tests.

```
delay(attempt) = jitter( min(BASE_RETRY_DELAY_MS × 2^(attempt − 1), MAX_RETRY_DELAY_MS) )
jitter(d)      = d/2 + random() × d/2        ("equal jitter")
```

- **Exponential**, so a struggling provider sees retries thin out rather than a storm.
- **Jittered**, so jobs that failed together (one outage) do not all return in the same
  instant. Equal jitter keeps at least half the backoff, so the delay never collapses to
  near zero as it can with full jitter.
- **Capped**, so a long outage does not push retries hours out.

Decisions:

| Failure | Attempts left | Outcome |
| --- | --- | --- |
| Permanent (`retryable: false`) | any | FAILED, immediately |
| Retryable | yes | PENDING, due after `delay(attempt)` |
| Retryable | no | DEAD_LETTERED |

**Attempts are counted at claim time.** A job that crashes its worker (a poison message)
still consumes an attempt on each claim, and eventually dead-letters instead of cycling
forever. Three paths refund the attempt because nothing reached the provider:
rate-limit deferral, the shutdown release, and any error before the provider call (for
example, the database dropping during the rate-limit check). An error *after* the
provider call is not refunded: the provider may have delivered, so the job is left to
recovery, which resends with the same delivery key.

Provider failures are values (`{ outcome: 'failed', retryable }`), not exceptions, so the
retry decision is explicit. `DeliveryService` turns anything thrown, and any call that
exceeds `PROVIDER_TIMEOUT_MS`, into a retryable failure.

## 12. Dead-letter handling

A job becomes DEAD_LETTERED when:

- its final attempt fails with a retryable error, or
- its final attempt's claim expires **twice**. The first time, the outcome is unknown:
  the worker may have died after the provider accepted the notification. Dead-lettering
  then would report a delivered notification as undeliverable. So recovery grants one
  extra attempt instead (`max_attempts + 1`, recorded in `reconciliation_granted`).
  Resending with the same delivery key either finds it already delivered (SENT) or
  delivers it. If that attempt's claim expires too, the job is dead-lettered. The grant
  is once per job, so a job that crashes every worker is still bounded.

It keeps its `last_error`, `attempt_count` and `dead_lettered_at`, emits a webhook, is
counted in `/metrics` (`deadLettered`), and is **never retried automatically**. The table
*is* the dead-letter queue:

- **Inspect it:** `GET /notifications?status=DEAD_LETTERED` lists it, newest first.
- **Redrive:** `POST /notifications/:id/retry` sends a dead job back to the queue, due now,
  with a fresh attempt budget. It is one conditional update
  (`WHERE status IN ('DEAD_LETTERED', 'FAILED')`), so it cannot touch a job in any other
  state.
- **Audit:** each redrive increments `redrive_count`, stamps `last_redriven_at`, and logs
  `job.redriven` with the previous error. `last_error` is kept as context until the next
  attempt overwrites it.
- **Webhooks after a redrive:** the redrive count is also the job's webhook generation.
  A redriven job that dead-letters again gets a second DEAD_LETTERED event instead of
  colliding with the first.

### Poison messages

A poison message is a job that can never succeed, and the risk is that it retries forever,
wasting capacity or taking workers down with it. Each kind ends in a terminal state after
bounded work:

| Kind | Example | What happens |
| --- | --- | --- |
| Invalid at the door | Malformed schedule, unknown channel, NUL characters, oversized body | Rejected with 400 before it becomes a job |
| Permanently rejected by the provider | Bad recipient address | FAILED on the first attempt; no retries |
| Always fails transiently | A provider that times out for this job every time | Retried with backoff, then DEAD_LETTERED after `MAX_RETRIES + 1` attempts |
| Crashes or hangs the worker | A payload that makes the process die mid-delivery | The attempt is counted when the job is claimed, so every crash uses one up. After the lease expires, recovery requeues it; the final attempt gets one reconciliation retry; then it is DEAD_LETTERED. It cannot cycle forever, and the other jobs in that worker's batch are recovered normally |

A provider timeout (`PROVIDER_TIMEOUT_MS`) and error containment in `DeliveryService`
mean a misbehaving provider call surfaces as an ordinary retryable failure instead of
taking the worker down.

FAILED is kept distinct from DEAD_LETTERED on purpose. FAILED means the provider said no
(retrying cannot help); DEAD_LETTERED means the provider kept failing (retrying later
might). An operator treats them differently: both can be redriven, but a FAILED job
should be redriven only after the cause of the rejection has been fixed.

## 13. Rate limiting

**Requirement:** each recipient receives at most N notifications per rolling window.

**Why the state is in PostgreSQL.** Workers are separate processes. A counter in one
worker's memory knows nothing about what the others sent, so limits have to live in
shared state.

**Why a sliding window, not a fixed-window counter.** A common approach is a counter row
with `window_start`, `window_end` and a count. That is a fixed window, and a fixed window
allows 2N at a boundary: N at 12:59:59 and N more at 13:00:00. The requirement is a rolling
limit, so the implementation keeps a small log instead:

- **`rate_limit_reservations`** holds one row per job admitted for delivery.
- **Admission** is allowed while fewer than N rows for the recipient fall inside the last
  window.
- **A refused job** gets the time the oldest row leaves the window, which is exactly when
  a slot frees.

**The race it must prevent:**

```
limit 10;  Worker A sees 9 used;  Worker B sees 9 used;  both send  →  11
```

Admission runs in one short transaction holding
`pg_advisory_xact_lock(namespace, hashtext(recipient))`, so checks for the same recipient
take turns:

```
BEGIN
  lock(recipient)
  already reserved this job inside the window?  → admit (retry or recovery keeps its slot)
  count reservations in the window
  count ≥ N  → refuse, retry at oldest + window
  else       → INSERT reservation, admit
COMMIT                                           ← lock released
```

**Why an advisory lock rather than a row lock.** A recipient's first notification has no
row yet, and `SELECT … FOR UPDATE` on zero rows locks nothing, so two workers would both
see "0 used". An advisory lock on the recipient exists whether or not any row does. A
hash collision between two recipients only makes them take turns; it can never let a
limit be exceeded.

**A limited job is not a failure.** It returns to PENDING at the retry time with its
attempt refunded. It is not failed, not dead-lettered, and it does not consume retries.

**Tested:** 20 simultaneous admissions for one recipient with a limit of 3 admit exactly
3. Ten workers competing over 40 jobs send exactly the limit. A sliding-window check over
several seconds of continuous draining finds no window above N. Removing the advisory
lock makes all three tests fail.

**What is counted:** admissions, not successes. An attempt that then fails still used its
slot. That is conservative, and it keeps the check off the provider's critical path.

## 14. Webhooks

When a job reaches SENT, FAILED or DEAD_LETTERED, the configured endpoint receives:

```json
{
  "eventId": "0b7f6d2e-5c1a-4e8b-9f3d-2a6c8e0b4d17",
  "jobId": "3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c",
  "status": "SENT",
  "attemptCount": 2,
  "timestamp": "2026-09-24T12:01:03.412Z"
}
```

with the header `X-Webhook-Event-Id: <eventId>`.

**Transactional outbox.** The obvious implementation, POSTing right after marking the job
SENT, loses the webhook if the worker dies between the two. Instead, the event row is
inserted **in the same transaction** as the status change (and, for recovery
dead-lettering, in the same statement). An event exists if and only if the status
changed. No crash can separate them.

**Dispatch.** Every worker runs a dispatcher on `WEBHOOK_POLL_INTERVAL_MS`:

1. **Claim due events** in one statement: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
   LOCKED LIMIT 50)`. This pushes `next_attempt_at` forward by a lease, so if a dispatcher
   dies mid-POST, its events become due again when the lease expires.
2. **POST each event** with a timeout. No transaction is open during the request.
3. **Record the result:** delivered; or retry with the same backoff policy as jobs; or give
   up after `WEBHOOK_MAX_ATTEMPTS`. The POST and the bookkeeping are handled separately:
   an endpoint that answered 2xx has the event, so a failure to *record* that is never
   counted as a failed delivery, let alone as giving up. The retry and give-up updates are
   fenced on the dispatch attempt number, so a dispatcher whose lease ran out cannot
   overwrite a newer attempt's state.

**Delivery guarantee: at-least-once.** A dispatcher can POST successfully and die before
recording it, so the event is sent again. Receivers must deduplicate on `eventId`. The
demo receiver (`POST /webhooks/mock`) does, and counts redeliveries so the behaviour is
visible. Claiming exactly-once here would require the receiver to take part, which is
the point of the event ID.

**Isolation.** Webhook failures only ever touch `webhook_events`. A webhook endpoint that
is down cannot change a job's status, slow a delivery, or block a worker.

## 15. Worker failure recovery

| Failure | Recovery |
| --- | --- |
| Worker crashes or hangs holding claims | Every worker periodically runs `recoverStaleClaims`: jobs PROCESSING with `locked_at` older than `JOB_VISIBILITY_TIMEOUT_SECONDS` go back to PENDING, their claim token is cleared, and they are due immediately. An expired final attempt gets one reconciliation attempt first; only a second expiry dead-letters (section 12). It uses `SKIP LOCKED`, so recovery running on many workers does not contend |
| A claimed job waits in a worker's queue past its lease | The start fence (section 7) refuses it if it was reclaimed meanwhile, so it is not sent twice; otherwise starting it renews the lease |
| The "dead" worker was only slow | Its claim token was cleared, so its eventual `markSent` changes nothing and it logs `job.claim_lost`. The job's next delivery uses the same delivery key, so the provider deduplicates it |
| Worker receives SIGTERM | It stops claiming and stops its timers, waits for any recovery or webhook run already in progress (so their writes land before the connection pool closes), returns queued-but-unstarted jobs to PENDING immediately (attempt refunded, due now), waits up to `WORKER_SHUTDOWN_TIMEOUT_MS` for running deliveries, and leaves anything still running to lease expiry |
| Provider call hangs | `PROVIDER_TIMEOUT_MS` bounds it. Startup refuses a timeout that is not shorter than the visibility timeout, because a call that outlived the lease would let recovery hand the job to a second worker while the first is still sending |

**The visibility timeout trade-off.** A shorter timeout recovers crashed work sooner, but
it must stay comfortably above the longest legitimate delivery, or live jobs get reclaimed
and delivered twice (safe with an idempotent provider, wasteful anyway). The default of
five minutes against a ten-second provider timeout leaves a wide margin.

**Graceful shutdown in containers.** Docker Compose runs each process under an init
process, so SIGTERM reaches Node, and it gives workers a stop grace period longer than the
drain timeout. After draining, Nest's shutdown hooks exit with `process.exit(0)` instead of
re-raising the signal. This matters because pino writes logs asynchronously and flushes
them on exit; re-raising SIGTERM skips that flush and loses the last log lines.

## 16. Failure matrix

| Failure | Expected behaviour | How it is guaranteed |
| --- | --- | --- |
| API crashes before the DB commit | No job created; the client gets no 201 and retries | The insert is one statement; the retry with the same key is idempotent |
| Duplicate request (same key, same body) | Existing job returned, 200 | `ON CONFLICT (idempotency_key) DO NOTHING` + fingerprint match |
| Same key, different body | 409 Conflict | Fingerprint mismatch |
| Concurrent duplicates | One job | The unique constraint arbitrates |
| Worker crashes before claiming | Job stays PENDING; another worker takes it | Nothing was written |
| Worker crashes after claiming | Job recovered after the visibility timeout; attempt counted | `recoverStaleClaims` |
| Worker crashes on the final attempt | One reconciliation attempt resends with the same delivery key: SENT if the provider had it, otherwise delivered now | `reconciliation_granted`, stable delivery key |
| Worker crashes on the reconciliation attempt too | Dead-lettered by recovery; webhook emitted | Same statement inserts the outbox event |
| Error before the provider call (e.g. database blip in the rate-limit check) | Job handed back at once, attempt refunded | `providerCalled` flag in the processor |
| Job reclaimed while waiting in the first worker's queue | First worker skips it; the new owner delivers it | Start fence (`startAttempt`) |
| Provider fails transiently | Retry with backoff | `RetryPolicyService` |
| Provider fails permanently | FAILED immediately | `retryable: false` |
| Provider keeps failing | DEAD_LETTERED after the last attempt | `attempt_count ≥ max_attempts` |
| Provider hangs | Timed out, retried | `PROVIDER_TIMEOUT_MS` |
| Provider succeeds, then worker crashes | Job recovered and resent with the same delivery key; the provider deduplicates; one logical delivery | Stable delivery key (section 10) |
| A slow worker finishes after its job was reclaimed | Its update is rejected; the new owner's result stands | Claim-token fencing |
| Webhook endpoint fails | Retried with backoff; given up after N attempts; job status unaffected | Outbox; dispatcher touches only `webhook_events` |
| Worker crashes between status change and webhook | Webhook still sent | Event written in the same transaction as the status |
| Dispatcher crashes mid-POST | Event redelivered after its lease; receiver dedupes by `eventId` | Lease on `next_attempt_at` |
| Webhook POST succeeds but recording it fails | Counted as delivered, not as a failure; redelivered after the lease and deduplicated | POST and bookkeeping handled separately |
| NUL character in the request | 400, not a 500 from PostgreSQL | `NoNullCharacters` validator |
| Recipient rate limited | Job stays queued until a slot frees; no attempt used | `deferRateLimited` |
| Client cancels while a worker claims the same job | Exactly one wins: cancelled and never sent, or sent and the cancel gets 409 | One conditional UPDATE each; the row lock orders them |
| A redriven job dead-letters again | A second DEAD_LETTERED webhook | Webhook uniqueness includes the redrive generation |
| Two workers race for a recipient's last slot | Only one is admitted | Per-recipient advisory lock |
| Database unavailable | API returns 500 (details logged, not returned); `/health` returns 503; workers log `worker.poll_failed` and keep retrying | Error filter; terminus; poll loop catches and reschedules |
| Worker receives SIGTERM | Running jobs finish; unstarted jobs released at once | `beforeApplicationShutdown` drain |

## 17. Observability

**Logs** are JSON lines via pino.

- **Every HTTP request:** one line with `requestId`, `method`, `path`, `statusCode` and
  `responseTime`. Client errors log at warn and server errors at error. Health probes are
  not logged.
- **Every worker event:** `workerId`, `jobId`, `attempt`, `event` and `durationMs`. Events
  include `job.sent`, `job.retry`, `job.dead_letter`, `job.fail`, `job.rate_limited`,
  `job.released`, `job.claim_lost`, `jobs.recovered`, `worker.drained` and
  `webhook.failed`. Operator actions log `job.cancelled` and `job.redriven`.

**Request IDs.** A caller's `X-Request-ID` is accepted if it is short and log-safe;
otherwise one is generated. It is echoed on every response, included in every error body,
and attached to the request's log line.

**Metrics** (`GET /metrics`) come from SQL aggregation, never by loading rows:

- job counts by status, zero-filled;
- `queueLagSeconds`, how long the oldest due job has waited to be claimed. This is the
  signal for "add workers";
- the webhook backlog: pending, delivered and given up.

**Health** (`GET /health`) runs the terminus check: the process answers, and PostgreSQL
responds to a ping within 1.5 s. The container health checks use it.

## 18. Security

- **Input validation.** Every DTO is whitelisted, and unknown properties are rejected
  (`forbidNonWhitelisted`). Enums, lengths, ranges and the schedule rules are all checked.
  NUL characters, which PostgreSQL cannot store, are rejected up front. JSON bodies are
  capped at 64 KB. Path IDs must be UUIDs.
- **Safe errors.** One error shape. Stack traces, SQL and internal messages are logged
  server-side and never returned; unexpected errors become a generic 500.
- **Safe logging.** Log serializers whitelist fields, so request bodies, headers and query
  strings are never written. A redaction list backs this up for anything logged by hand.
  Notification payloads are never logged and never returned by the API. A test asserts a
  payload marker appears in no log line.
- **Database errors are logged by code, not content.** A TypeORM query error carries its
  SQL and bound parameters (recipients, payloads), and PostgreSQL's messages can quote
  input values. Every such error is logged as its class, SQLSTATE and constraint name
  only. That applies both where the app logs errors deliberately and, through a pino
  serializer, wherever else one might end up in a log.
- **Secrets** come from the environment only, are validated at boot, and are never logged.
- **Least privilege in the container.** The runtime image has no dev dependencies and
  runs as the non-root `node` user.
- **HTTP hardening.** Helmet sets the standard security headers and removes
  `X-Powered-By`. API responses carry a Content-Security-Policy that allows nothing
  (they are JSON); the Swagger UI gets one that permits only its own inline bootstrap code.
- **Network exposure in Compose.** PostgreSQL is published on `127.0.0.1` only, so the
  demo credentials are not reachable from the local network. Workers publish no port.
- **Dependencies.** `npm audit` reports no known vulnerabilities.
- **Demo-only surfaces.** `POST /webhooks/mock` is an unauthenticated demo receiver that
  writes to its own table; it would not exist in production, where the webhook target is a
  customer's endpoint. The Swagger UI is public, which suits an assessment but would sit
  behind authentication or be disabled in production.
- **Out of scope for the assessment, and needed in production:** API authentication,
  HMAC-signed webhooks, TLS to PostgreSQL, and a least-privilege database role (the app
  needs DML only; migrations need DDL).

## 19. Scalability

How the system grows from one worker to a thousand and to millions of jobs, and when each
technique earns its place.

**1 to 10 workers.** Nothing changes. `SKIP LOCKED` hands each worker a disjoint batch,
the claim index keeps each poll to a short index scan, and idle workers cost one query
per poll interval.

**10 to 100 workers.** Connections become the first constraint. Each worker holds a small
pool (`DATABASE_POOL_MAX`), but 100 workers × 10 connections is 1,000 connections, and
PostgreSQL handles that poorly.

- Put **PgBouncer in transaction mode** in front. Every transaction here is short, and
  none spans a network call, which is exactly what transaction pooling needs.
  Transaction-scoped advisory locks (`pg_advisory_xact_lock`) are compatible with it;
  session-level locks would not be.
- **Tune the batch against the poll interval.** Larger batches mean fewer round trips;
  smaller batches spread bursts more fairly across workers.

**100 to 1,000 workers, millions of jobs.**

- **Keep the hot table small.** Terminal rows are the bulk of the data and are never
  claimed. Partition `notification_jobs` by `created_at` (or move terminal rows to an
  archive table) and drop old partitions. The partial indexes already exclude them from
  the hot path; partitioning keeps vacuum and backups cheap too.
- **Watch the claim query's contention.** With very many workers polling, most rows they
  scan are locked by others and skipped. Mitigations:
  - poll less often and in larger batches;
  - **shard the queue**: a `shard` column (hash of the job ID mod K) and a partial index
    per shard, with each worker polling its own shard and falling back to others when
    idle.
- **Scale reads separately.** `GET /notifications/:id` and `/metrics` can move to a read
  replica. Claiming, rate limiting and the outbox must stay on the primary.
- **Rate-limit contention** is per recipient, so it only bites for very hot recipients.
  The advisory lock is held for microseconds. The real cost at scale is the churn
  described in section 20.

**When to leave PostgreSQL.** A single PostgreSQL primary comfortably handles thousands
of claims per second. Past the point where one primary cannot absorb the write rate, a
dedicated broker takes over the queue role:

| Option | When it fits | What it costs |
| --- | --- | --- |
| **SQS** | Managed, elastic, visibility timeouts built in | At-least-once only; no priorities within a queue (use one per priority); delay capped at 15 minutes, so long schedules still need a table |
| **RabbitMQ** | Rich routing, priorities, dead-letter exchanges | Another stateful system to run; delayed delivery via a plugin |
| **Kafka** | Very high throughput, replay, event streams | Poor fit for per-message scheduling, retries and priorities; you build those on top |
| **Redis** (sorted sets, streams) | Very low latency scheduling | Durability and transactional coupling with the job record become your problem |

In every case the database remains the system of record for job state, and the
transactional coupling PostgreSQL gives for free (status change + outbox event in one
commit; idempotent insert via a constraint) has to be rebuilt, usually as an outbox
feeding the broker. That is why this design stays in PostgreSQL until the numbers force
the move.

## 20. Bottlenecks

In the order they would bite:

1. **Connections.** One pool per worker; solved with PgBouncer (section 19).
2. **Claim contention on the primary.** Many workers scanning the same index head; solved
   with sharding and batch tuning.
3. **Hot-recipient churn.** Claiming does not know about rate limits, so a backlog of
   thousands of jobs for one recipient is claimed, refused and deferred each time a slot
   frees. It is correct but costs work proportional to the backlog on every slot. Fix:
   have the claim query skip recipients with a known future reset (a small
   `recipient_next_allowed_at` table), or give hot recipients their own queue.
4. **Table growth.** Solved with partitioning or archiving of terminal rows.
5. **Outbox growth.** Delivered events can be pruned on a schedule. The partial index
   keeps dispatch fast regardless.

## 21. Trade-offs

| Decision | Alternative | Why this one |
| --- | --- | --- |
| PostgreSQL as the queue | Redis, SQS, RabbitMQ | One system, and transactional coupling between job state, idempotency, rate limits and the outbox. Scales further than most systems need (section 19) |
| Lease with a fencing token | Lock held across delivery | Never hold locks across network calls; the token makes a late worker harmless |
| Attempts counted at claim | Counted on failure | Poison messages exhaust their attempts instead of cycling forever. Costs a refund on deferral and release |
| FAILED separate from DEAD_LETTERED | One failure state | Different causes, different operator responses |
| Sliding-window rate limit | Fixed-window counter | The requirement is a rolling limit; a fixed window allows 2N at a boundary. Costs one row per admission, pruned periodically |
| Advisory lock per recipient | Row lock | A new recipient has no row to lock |
| Transactional outbox | POST after commit | A crash cannot lose a webhook. Costs one insert per terminal transition and a dispatcher |
| `ON CONFLICT DO NOTHING` + read back | Check then insert, catch the unique violation | No race window and no error-driven control flow |
| 409 on key reuse | Return the existing job regardless | A client reusing a key for a different notification has a bug worth surfacing |
| Priority as smallint | Text enum | `ORDER BY priority DESC` sorts by urgency, not alphabetically |
| Partial indexes | Status-leading composites | Smaller, and they match the claim query's order exactly |
| Database clock for all due times | Worker clock | Clock skew between machines cannot make workers disagree |
| One image, `APP_ROLE` | Separate API and worker apps | One artifact to build, test and deploy; the roles scale independently |
| Mock provider state in PostgreSQL | In-memory map | A recovered job usually lands on a different worker; an in-process map would fake the idempotency guarantee |
| A small pino wrapper | `nestjs-pino` | `nestjs-pino` (CommonJS) `require`s the ESM-only Nest 12 in a cycle, which the test runner's ESM loader rejects. About a hundred lines, and tests can capture log output |
| One reconciliation attempt for an expired final claim | Dead-letter immediately | The provider may already have delivered; dead-lettering would misreport it. Bounded to once per job |

## 22. Future improvements

- **Authorisation for operator actions**: cancel and redrive should require an operator
  role, and redrive a reason, stored alongside the audit fields.
- **Bulk redrive** (`POST /notifications/retry?status=DEAD_LETTERED&since=…`) after an
  outage, rate-limited so it does not stampede the provider.
- **Rate-limit-aware claiming** to remove hot-recipient churn (section 20).
- **Signed webhooks** (HMAC-SHA256 of the body with a shared secret, plus a timestamp to
  stop replays).
- **Pruning** of delivered webhook events and old terminal jobs on a schedule.
- **Prometheus** exposition of the same metrics, plus per-worker counters (deliveries,
  failures, claim latency).
- **Per-channel providers** behind the same interface, with per-provider timeouts and
  concurrency.
- **Authentication and per-tenant quotas** on the API.

## 23. Design questions, answered

**Why PostgreSQL?** It already provides everything a reliable queue needs: transactions,
row-level locks, `SKIP LOCKED`, advisory locks, unique and check constraints, durability,
and `jsonb` for payloads. Most importantly, it lets a status change, its webhook event and
its idempotency record commit together, which no external broker gives you without an
outbox of its own.

**Why the repository pattern?** It separates persistence from business rules. Locking and
transactions are concentrated where they can be reviewed. Services are testable without a
database. Query logic lives in one place per table.

**Why `SKIP LOCKED`?** So many workers can claim different jobs at the same moment without
waiting on rows another worker already holds. Throughput grows with workers instead of
serialising behind a lock.

**Why an idempotency key?** It makes the API safe to retry. A client that times out and
resends, or sends twice concurrently, gets one job.

**Why provider idempotency as well?** The idempotency key protects against duplicate
*requests*; the delivery key protects against duplicate *side effects* during crash
recovery. They solve different problems, and the second is the only defence for the
crash-after-send window.

**Why exponential backoff?** It stops a failing provider from being hit by an immediate
retry storm, and gives transient problems time to clear.

**Why jitter?** Jobs that failed together, in the same outage, would otherwise retry in
the same instant and fail together again. Jitter spreads them out.

**Why rate-limit in PostgreSQL?** Workers are distributed. The limit is a global property
of a recipient, and local memory cannot represent global state.

## 24. Simplifying assumptions

Where the brief left room, or where a production system would need more, these are the
assumptions made, why each is reasonable here, and what changes in production.

| Assumption | Why it is reasonable here | In production |
| --- | --- | --- |
| **The provider honours idempotency keys.** The exactly-once *delivery* claim rests on it (section 10). | Most real email, SMS and push APIs accept one, and the mock implements it faithfully (shared state, not per process) | Use each provider's idempotency key; where one has none, the honest guarantee is at-least-once |
| **The provider is a mock** with a configurable random transient failure rate, and permanent rejection for recipients starting `invalid`. | The brief asks for a stub sender with simulated failures | Real providers behind the same interface, one per channel |
| **PostgreSQL is the only infrastructure**: queue, locks, rate-limit store and outbox. | One dependency to run and reason about, with transactional guarantees across all of them; it scales further than most systems need | Unchanged until the write rate outgrows one primary (section 19) |
| **Jobs fire at or after their scheduled time**, within about one poll interval (1 s by default). | Notifications tolerate second-level latency | Shorter poll interval or `LISTEN/NOTIFY` wake-ups for tighter timing |
| **Priority is strict** among due jobs: a steady stream of HIGH jobs can hold LOW jobs back indefinitely. | The brief asks for high before low whenever both are due | Add aging (effective priority rises with wait time) or reserve a share of each batch for lower priorities |
| **Recipient identity is the string as given.** `A@example.com` and `a@example.com` are different recipients for rate limiting, and addresses are not validated per channel. | Normalisation rules differ by channel and provider | Normalise per channel (lower-case emails, E.164 phone numbers) before storing |
| **One rate limit for everyone**: N per recipient per window, across all channels, counting admissions rather than successful deliveries. | Matches the brief's "N per recipient per hour"; counting admissions is the conservative choice | Per-channel or per-tenant limits; possibly count only successful sends |
| **Webhooks fire for terminal states only** (SENT, FAILED, DEAD_LETTERED), to one global `WEBHOOK_URL`, unsigned. | These are the status changes the brief names | Per-tenant or per-job URLs, HMAC signatures, possibly PENDING/PROCESSING events |
| **The dead-letter queue is a status**, not a separate table or topic. | A status is queryable, indexed and consistent with the job's history, and a redrive is one conditional update | Unchanged; add authorisation and a required reason to redrive (section 22) |
| **Cancel and redrive are open to any caller**, like the rest of the API. | There is no authentication anywhere in the assessment | Operator-only, with the acting user recorded |
| **No authentication or multi-tenancy.** | Out of scope for the brief | Authentication on every endpoint, tenant ID on every row, per-tenant quotas |
| **Payloads are opaque JSON** up to 64 KB, not validated against a per-channel schema. | The system transports notifications; rendering them is the provider's job | Per-channel schemas (subject and body for email, length limits for SMS) |
| **Scheduling horizon is 365 days**; a `sendAt` in the past is due immediately. | Guards against typos (year 2099) while tolerating client clock skew | Configurable per tenant |
| **The database clock is authoritative** for every due time, lease and window. | Removes clock skew between worker machines from the correctness argument | Unchanged |

