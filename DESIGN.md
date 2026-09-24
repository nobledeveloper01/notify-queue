# Notify Queue: Design

This document explains how Notify Queue is designed and why. It is written in plain
English. The full technical detail (SQL, indexes and locking) is in
[docs/technical-design.md](docs/technical-design.md).

## Contents

1. [Requirements](#1-requirements)
2. [Architecture](#2-architecture)
3. [The key decision: PostgreSQL is the queue](#3-the-key-decision-postgresql-is-the-queue)
4. [The life of a notification](#4-the-life-of-a-notification)
5. [Exactly-once delivery](#5-exactly-once-delivery)
6. [Where race conditions could occur](#6-where-race-conditions-could-occur)
7. [Priority](#7-priority)
8. [Rate limiting](#8-rate-limiting)
9. [Retries and backoff](#9-retries-and-backoff)
10. [The dead-letter queue and poison messages](#10-the-dead-letter-queue-and-poison-messages)
11. [Duplicate requests](#11-duplicate-requests)
12. [Webhooks](#12-webhooks)
13. [Scaling, and what breaks first](#13-scaling-and-what-breaks-first)
14. [Simplifying assumptions](#14-simplifying-assumptions)
15. [Trade-offs](#15-trade-offs)
16. [Glossary](#16-glossary)

---

## 1. Requirements

Notify Queue must:

- let a client schedule a notification (email, SMS or push) for a set time or after a delay;
- deliver each notification **exactly once**, even with many workers running at the same time;
- send HIGH-priority notifications before NORMAL and LOW ones when several are due;
- retry failed deliveries with exponential backoff, up to a limit, and then move the
  notification to a **dead-letter queue**;
- handle **poison messages** (notifications that can never succeed) without looping forever;
- ignore duplicate requests that use the same **idempotency key**;
- limit how many notifications one recipient receives per hour, making extra notifications
  wait instead of failing them;
- call a **webhook** when a notification is sent, fails or is dead-lettered;
- provide a status endpoint and a metrics endpoint.

## 2. Architecture

```
                         ┌────────────┐
   Client requests ────▶ │    API     │
                         └─────┬──────┘
                               ▼
                         ┌────────────┐
                         │ PostgreSQL │   every notification, its status,
                         └─────┬──────┘   the rate limits and the webhook events
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
           ┌─────────┐    ┌─────────┐    ┌─────────┐
           │ Worker  │    │ Worker  │    │ Worker  │
           └────┬────┘    └────┬────┘    └────┬────┘
                ▼              ▼              ▼
          Email / SMS / Push provider, then a webhook call to the client
```

The system has three parts:

- **The API** receives requests, validates them and saves notifications to the database.
  It never delivers anything itself.
- **PostgreSQL** stores every notification and its current status. It is also the queue.
- **Workers** repeatedly ask the database for notifications that are due, deliver them,
  and record the result. Any number of workers can run. They never talk to each other,
  only to the database, so adding capacity simply means starting more workers.

The API and the workers are the same program, started in different roles. This means
there is one thing to build, test and deploy, while the workers can still be scaled
separately from the API.

Inside the code, every feature follows the same three layers:

- **Controllers** handle HTTP: they validate the request and call a service.
- **Services** hold the business rules, such as when a notification is due or whether a
  request is a duplicate.
- **Repositories** are the only code that talks to the database.

Keeping the database code in one layer makes the locking and transaction logic easy to
review, and it lets the business rules be tested without a database.

## 3. The key decision: PostgreSQL is the queue

I used PostgreSQL as the queue instead of adding a separate message broker such as
RabbitMQ or Kafka. There are three reasons.

1. **It already has what a reliable queue needs.** Transactions, row locks and unique
   constraints are exactly the tools needed to stop two workers taking the same
   notification and to stop duplicate requests.
2. **Related changes happen together.** When a notification is marked as sent, the webhook
   event that reports it is saved in the same transaction. Either both are saved or
   neither is. With a separate broker, they would live in two systems, and a crash between
   the two writes could lose one of them.
3. **It is simpler to run.** There is one system to operate and understand, and one
   PostgreSQL server can handle thousands of notifications per second.

Section 13 explains when a dedicated broker would become worth adding.

## 4. The life of a notification

```
                         ┌──▶ SENT
PENDING ──▶ PROCESSING ──┼──▶ FAILED          (the provider rejected it permanently)
   ▲                     ├──▶ DEAD_LETTERED   (every attempt failed)
   │                     │
   └─────────────────────┘    temporary failure: back to PENDING to retry later
```

1. **PENDING:** the notification is saved and waiting until it is due.
2. **PROCESSING:** a worker has claimed it. No other worker can take it.
3. **SENT:** the provider accepted it.

Other possible outcomes:

- **FAILED:** the provider rejected it permanently, for example because the address does
  not exist. Retrying would not help.
- **DEAD_LETTERED:** every attempt failed with a temporary error. It is set aside for an
  operator to look at.
- **CANCELLED:** the client cancelled it before it was sent.

SENT, FAILED, DEAD_LETTERED and CANCELLED are final. The system never moves a notification
out of these states on its own. Only an operator can send a FAILED or DEAD_LETTERED
notification back to PENDING, using the retry endpoint.

## 5. Exactly-once delivery

This is the most important guarantee. It is achieved in two layers.

### Layer 1: only one worker can take a notification

When a worker asks for due notifications, it uses a PostgreSQL feature called
`SELECT ... FOR UPDATE SKIP LOCKED`. In plain terms, this means: "give me the next due
notifications, lock them for me, and skip any that another worker has already locked."

So if three workers ask at the same moment, each one receives a different set of
notifications. No notification goes to two workers, and no worker has to wait for another.

The lock is held for only a few milliseconds. The worker marks the notifications as
PROCESSING, records that it owns them, and releases the lock **before** it contacts the
email or SMS provider. A database lock is never held while waiting for an outside
service; otherwise, a slow provider would slow down the whole database.

### Layer 2: a crash cannot cause a second delivery

One risk remains, and no queue can remove it on its own:

1. A worker sends an email, and the provider delivers it.
2. The worker crashes before it can record that the email was sent.
3. After five minutes, the system assumes the worker has died and gives the notification
   to another worker.
4. The second worker sends it again.

To prevent a second email, every attempt at the same notification uses the same
**idempotency key** with the provider: the notification's ID. The provider recognises a
key it has already processed and does not send the email again. The customer receives one
email, and the second worker records the notification as SENT.

To be precise about the guarantee: the database ensures that only one worker holds a
notification at any time, and the idempotency key ensures one delivery, **provided that
the provider supports idempotency keys**. Most real email and SMS providers do. The
simulated provider in this project does as well.

### A slow worker cannot overwrite a newer result

A worker might be slow rather than dead. If its claim expires, another worker takes over.
Each claim has a unique **claim token**, and the database accepts a result only from the
worker that holds the current token. When the slow worker finally reports back, its update
is rejected, so it cannot overwrite the newer result.

### How this is tested

These tests run against a real PostgreSQL database:

- 10 workers try to take the same notification at the same moment, 25 times in a row.
  Exactly one worker succeeds every time.
- 300 notifications are processed by 10 workers. The provider is called exactly 300 times.
- A control test shows that a simpler approach without the lock gives one notification to
  several workers.

## 6. Where race conditions could occur

| Situation | What could go wrong | What prevents it |
| --- | --- | --- |
| Two workers poll at the same moment | The same notification is delivered twice | `SKIP LOCKED` gives each worker different notifications |
| A worker crashes after the provider delivered | A retry delivers a second copy | The same idempotency key is used on every attempt |
| A slow worker finishes after another worker took over | The old result overwrites the new one | The claim token |
| Two identical requests arrive at the same moment | Two notifications are created | A unique constraint on the idempotency key |
| Two workers check the same recipient's rate limit | The limit is exceeded by one | A per-recipient lock during the check (section 8) |
| A client cancels while a worker claims the notification | A cancelled notification is still sent | A single conditional update; only one of the two can succeed |
| A crash happens between the status update and the webhook | The webhook is lost | Both are saved in one transaction |

## 7. Priority

Every notification is HIGH, NORMAL or LOW. When a worker asks for due notifications, it
receives them in this order:

1. highest priority first;
2. within the same priority, the one that has been due the longest;
3. then the one that was created first.

For example, if a LOW newsletter, a NORMAL order confirmation and a HIGH password-reset
code are all due, the password-reset code is sent first.

The database keeps an index (a pre-sorted list) that contains only waiting notifications,
already in this order. A worker reads from the top of that list instead of sorting the
whole table, so claiming stays fast however many old notifications build up.

## 8. Rate limiting

Each recipient can receive at most **10 notifications in any rolling hour** (both numbers
are configurable).

- **Why the limit is stored in the database.** The workers are separate processes. A
  counter in one worker's memory cannot know what the other workers have sent, so the
  count must be shared.
- **Why a rolling hour.** A limit that resets on the hour would allow 10 notifications at
  12:59 and 10 more at 13:00: 20 in two minutes. A rolling hour counts the last 60 minutes
  from the current moment, so that cannot happen.
- **Extra notifications wait; they are not failed.** A notification over the limit goes
  back to PENDING and becomes due at the exact moment a slot frees up. Waiting does not
  use up any of its retry attempts.
- **No race between workers.** If two workers check the same recipient at the same moment,
  both might see "one slot left" and both send. To prevent this, each check briefly locks
  that recipient, so the checks happen one after the other. Other recipients are not
  affected.

## 9. Retries and backoff

When a delivery fails, the first question is whether trying again could help.

- **Permanent failure** (for example, the address does not exist): the notification is
  marked FAILED immediately. There is no point retrying.
- **Temporary failure** (for example, the provider is down or does not respond in time):
  the notification is retried later.

Each retry waits about twice as long as the previous one:

| After failed attempt | Wait before the next attempt |
| --- | --- |
| 1 | 0.5 to 1 second |
| 2 | 1 to 2 seconds |
| 3 | 2 to 4 seconds |
| 4 | 4 to 8 seconds |
| 5 | 8 to 16 seconds |

The wait never exceeds one minute, and all of these values are configurable.

- **Why wait longer each time?** If the provider is struggling, retrying immediately makes
  things worse. Longer waits give it time to recover.
- **Why is there a range?** A random amount, called **jitter**, is added to each wait. If a
  thousand notifications failed during the same outage, jitter stops them all retrying at
  the same instant and overloading the provider again.

By default, a notification gets **6 attempts** in total: the first attempt plus 5 retries.

## 10. The dead-letter queue and poison messages

### The dead-letter queue

When a notification has used all 6 attempts, it is marked **DEAD_LETTERED**. It is not
retried forever, and it is not deleted.

- It keeps its history: the number of attempts and the last error.
- A webhook reports it, and it appears in the metrics.
- An operator can list the dead-letter queue: `GET /notifications?status=DEAD_LETTERED`.
- An operator can send it back with a fresh set of attempts, for example after an outage:
  `POST /notifications/{id}/retry`. Each retry by an operator is recorded on the
  notification.

FAILED and DEAD_LETTERED are kept separate on purpose. FAILED means the provider rejected
the notification, so something must be fixed first. DEAD_LETTERED means the provider kept
failing, so trying again later may simply work.

### Poison messages

A poison message is a notification that can never succeed. The danger is that it retries
forever or keeps crashing workers. Each kind is stopped:

| Kind of poison message | What happens |
| --- | --- |
| Invalid request (bad date, unknown channel, body too large) | Rejected with a 400 error; it never enters the queue |
| The provider always rejects it | Marked FAILED after one attempt |
| The provider always times out on it | Retried with backoff, then dead-lettered |
| It crashes the worker every time | Dead-lettered after its attempts run out |

The last case works because **an attempt is counted as soon as a worker takes a
notification**, not when the attempt fails. Even if a notification crashes the worker every
time, each crash uses up an attempt, so it cannot loop forever.

Two situations do not use up an attempt, because the notification was never actually
tried: waiting for the rate limit, and being returned to the queue when a worker shuts down.

## 11. Duplicate requests

Networks are unreliable. A client may send a request, not receive the response in time,
and send the same request again. Without protection, the recipient would get two emails.

Every request therefore includes an **idempotency key**: a unique value chosen by the
client, similar to an order number.

- **First request with a key:** the notification is created, and the response is **201**.
- **The same request again:** nothing new is created, and the response is **200** with the
  original notification.
- **The same key with different details:** the response is **409**, because reusing a key
  for a different notification is almost certainly a client mistake.

A unique constraint in the database enforces this, so it holds even when two identical
requests arrive at exactly the same moment. In a test, 25 identical requests sent at once
created exactly one notification.

## 12. Webhooks

When a notification is SENT, FAILED or DEAD_LETTERED, Notify Queue calls the client's
webhook URL with a short message:

```json
{ "eventId": "0b7f6d2e-...", "jobId": "3f6c2b0e-...", "status": "SENT",
  "attemptCount": 2, "timestamp": "2026-09-24T12:01:03Z" }
```

- **A webhook is never lost.** The webhook event is saved in the same transaction as the
  status change. If a server crashes afterwards, the event is still in the database and is
  sent later.
- **Failed webhook calls are retried** with backoff, up to 10 times.
- **A webhook can occasionally arrive twice**, for example if the server crashes after
  sending it but before recording that it was sent. Each webhook has a unique `eventId`,
  so the receiver can ignore repeats. This is called **at-least-once** delivery.
- **A failing webhook never changes the notification.** A notification that was sent stays
  SENT, even if its webhook cannot be delivered.

## 13. Scaling, and what breaks first

**What already scales.** Workers keep no state of their own, so adding workers adds
capacity. Because of `SKIP LOCKED`, workers do not wait for each other. Workers take
notifications in batches, so one database query serves many notifications.

As the system grows to millions of notifications and thousands of workers, the database is
what comes under pressure. These are the limits, in the order they would be reached:

| Order | What breaks | The fix |
| --- | --- | --- |
| 1 | **Database connections.** 1,000 workers with 10 connections each need 10,000 connections, but PostgreSQL handles a few hundred well. | A connection pooler such as PgBouncer, so many workers share a small number of connections. |
| 2 | **Workers competing for the front of the queue.** With hundreds of workers polling, they spend time skipping rows that other workers have locked. | Split the queue into shards, with each worker mainly polling its own shard. |
| 3 | **Recipients with a large backlog.** Workers repeatedly pick up and defer notifications that are over the rate limit. | Make workers skip recipients who are known to be at their limit. |
| 4 | **Table size.** Millions of finished notifications make the table large. | Partition the table by date and archive old data. |

One PostgreSQL server can handle thousands of notifications per second, which is enough
for most businesses. Beyond that, a dedicated broker such as Amazon SQS or Kafka would take
over the queue, and PostgreSQL would remain the record of each notification's status. That
move has a cost: a broker cannot save a status change and its webhook event in one
transaction, so that guarantee would have to be rebuilt.

## 14. Simplifying assumptions

| Assumption | Why it is reasonable here | What production would need |
| --- | --- | --- |
| The email/SMS/push provider is **simulated**, with a configurable random failure rate. | The brief asks for a mock sender with random failures. | Real providers behind the same interface. |
| The provider **supports idempotency keys**. Exactly-once delivery depends on this. | Most real email and SMS providers do. | Use each provider's idempotency feature. Where there is none, the guarantee becomes at-least-once. |
| **PostgreSQL is the only infrastructure.** | It keeps the system simple and consistent, and it scales a long way. | The same, until one server is not enough (section 13). |
| Notifications are sent **within about one second** of their scheduled time. | Notifications do not need millisecond precision. | Poll more often if tighter timing is needed. |
| **Priority is strict.** A constant stream of HIGH notifications could delay LOW ones for a long time. | The brief asks for high priority before low. | Raise a notification's priority the longer it waits (aging). |
| The rate limit is the **same for every recipient and channel**. | The brief asks for N notifications per recipient per hour. | Separate limits per channel or per customer. |
| A recipient is identified by the **exact text given**, so `Ada@example.com` and `ada@example.com` count separately. | Each channel has its own rules for matching addresses. | Normalise addresses before saving them. |
| Webhooks go to **one URL**, only for final outcomes, and are **not signed**. | These are the status changes the brief lists. | A URL per client, and signed webhooks. |
| There is **no authentication**. | It is outside the scope of the brief. | Authentication, with operator-only access to cancel and retry. |

## 15. Trade-offs

| I chose | Instead of | Benefit | Cost |
| --- | --- | --- | --- |
| PostgreSQL as the queue | A message broker | One system; status, duplicates, rate limits and webhooks stay consistent | Very large scale eventually needs sharding or a broker |
| Counting an attempt when a notification is picked up | Counting it when it fails | A notification that crashes workers still runs out of attempts | Waiting jobs (rate limit, shutdown) must have their attempt given back |
| A rolling-hour rate limit | A limit that resets every hour | No double burst around the hour | A small record is kept for each delivery |
| Saving webhooks in the same transaction as the status | Calling the webhook immediately | A crash can never lose a webhook | A webhook can occasionally arrive twice |
| Returning 409 when a key is reused with different details | Silently returning the old notification | Client mistakes are visible | Clients must use a new key for each new notification |
| One final re-check when a worker crashes on the last attempt | Marking the notification as failed straight away | The email may already have been delivered; re-sending with the same key confirms it | At most one extra attempt per notification |

## 16. Glossary

| Term | Meaning |
| --- | --- |
| **API** | The part of the system that other systems send requests to |
| **Worker** | A process that picks up due notifications and delivers them |
| **Queue** | The notifications waiting to be sent |
| **Claim** | A worker taking a notification so that no other worker can take it |
| **`SKIP LOCKED`** | A PostgreSQL feature that lets each worker skip notifications another worker has locked |
| **Idempotency key** | A unique value that makes a repeated request or delivery have no extra effect |
| **Exponential backoff** | Waiting about twice as long before each retry |
| **Jitter** | A small random amount added to each wait, so retries do not all happen together |
| **Dead-letter queue** | Where notifications go after every attempt has failed |
| **Poison message** | A notification that can never succeed |
| **Rate limit** | The maximum number of notifications one recipient can receive in an hour |
| **Webhook** | A call Notify Queue makes to the client's system to report a status change |
| **At-least-once** | Something is delivered one or more times, never zero times |
