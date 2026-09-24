# Notify Queue: How It Works

This document explains the design of Notify Queue in plain language. You do not need to
be an engineer to follow it. Engineers who want the full technical detail (database
queries, indexes, locking) will find it in
[docs/technical-design.md](docs/technical-design.md).

## Contents

1. [What problem does this solve?](#1-what-problem-does-this-solve)
2. [The big picture](#2-the-big-picture)
3. [The life of one notification](#3-the-life-of-one-notification)
4. [Never sending the same notification twice](#4-never-sending-the-same-notification-twice)
5. [Urgent notifications go first](#5-urgent-notifications-go-first)
6. [When sending fails: retries](#6-when-sending-fails-retries)
7. [Giving up safely: the dead-letter queue](#7-giving-up-safely-the-dead-letter-queue)
8. [Problem notifications ("poison messages")](#8-problem-notifications-poison-messages)
9. [The same request sent twice](#9-the-same-request-sent-twice)
10. [Not flooding one person: rate limiting](#10-not-flooding-one-person-rate-limiting)
11. [Telling other systems what happened: webhooks](#11-telling-other-systems-what-happened-webhooks)
12. [Checking on things: status, lists and numbers](#12-checking-on-things-status-lists-and-numbers)
13. [Cancelling and re-trying by hand](#13-cancelling-and-re-trying-by-hand)
14. [When things break](#14-when-things-break)
15. [Growing to millions of notifications](#15-growing-to-millions-of-notifications)
16. [Simplifying assumptions](#16-simplifying-assumptions)
17. [Choices we made, and what they cost](#17-choices-we-made-and-what-they-cost)
18. [A few words, explained](#18-a-few-words-explained)

---

## 1. What problem does this solve?

Businesses constantly need to send messages at particular times: a reminder email the day
before an appointment, a text message with a code, an app alert when an order ships.
Notify Queue is a service that **holds messages until it is time to send them, then sends
each one exactly once**. It works like a post office that keeps letters until their
delivery date.

It has to keep working when:

- **thousands of messages** fall due at the same moment;
- **several copies of the sending program** run at once to keep up, and must not
  trip over each other;
- **the outside service** that actually delivers email or text messages is slow or down;
- **a computer crashes** half-way through its work.

## 2. The big picture

There are three parts:

```
   Businesses                     ┌────────────┐
   send requests  ─────────────▶  │    API     │   the front desk: takes orders
                                  └─────┬──────┘
                                        ▼
                                  ┌────────────┐
                                  │  Database  │   the ledger: every notification
                                  └─────┬──────┘   and its current status
                           ┌────────────┼────────────┐
                           ▼            ▼            ▼
                      ┌────────┐   ┌────────┐   ┌────────┐
                      │ Worker │   │ Worker │   │ Worker │   the couriers: pick up
                      └────────┘   └────────┘   └────────┘   due messages and send them
                           │            │            │
                           ▼            ▼            ▼
                    Email / SMS / push services, then a status report back to the business
```

- **The API (the front desk)** accepts requests like "send this email to Ada at 9 am
  tomorrow". It checks the request, writes it into the ledger, and replies with a
  tracking number (the job ID).
- **The database (the ledger)** is the single record of every notification: what it is,
  when it is due, and what has happened to it so far. It is the one thing everyone
  shares, and it is where all the rules below are enforced.
- **Workers (the couriers)** repeatedly ask the ledger "what is due now?", take some
  messages, send them, and write down the result. You can run as many as you need.
  They never talk to each other; they only talk to the ledger.

The ledger is a PostgreSQL database. It is the only piece of infrastructure the system
needs.

## 3. The life of one notification

1. **Scheduled.** A business asks for an email to be sent at 9:00. The front desk records
   it as **PENDING** (waiting) and hands back a tracking number.
2. **Due.** At 9:00 the message becomes available to workers.
3. **Claimed.** One worker takes it. The ledger now marks it **PROCESSING** and notes who
   has it. No other worker can take it.
4. **Sent.** The worker hands it to the email service, which accepts it. The ledger marks
   it **SENT**.
5. **Reported.** A status update ("message X was sent") goes back to the business's own
   system.

When something goes wrong along the way, the notification may instead:

- **wait and try again** after a short pause (section 6);
- end up **FAILED**, if the email service says it can never be delivered, for example
  because the address does not exist;
- end up **DEAD_LETTERED**, if it keeps failing and the retry limit is used up
  (section 7);
- be **CANCELLED**, if the business cancels it before it goes out (section 13).

## 4. Never sending the same notification twice

This is the most important promise, and it has two halves.

### Half one: only one worker can take a message

Picture a deli counter where several staff serve from one queue of tickets. If two staff
glanced at the queue at the same instant, both might call the same customer. Here, when
a worker takes messages, the ledger **locks** them for that worker in a single step.
Another worker looking at the same moment simply skips the locked ones and takes the
next ones along. Every worker ends up with a different set of messages, with no waiting
and no clashes.

We test this directly. Ten workers grab for the same single message at the same instant,
twenty-five times over, and every time exactly one gets it. We also show the opposite: a
simpler approach without the lock hands one message to several workers.

### Half two: a message sent just before a crash is not sent again

There is one moment no queue can fully protect on its own:

```
Worker takes the message → hands it to the email service → the email goes out
→ the worker's computer crashes before it can write "SENT" in the ledger
```

The ledger still says "in progress". After a while (five minutes by default) the system
assumes that worker is gone and gives the message to another worker, which would send it
again.

The fix is a **reference number that never changes** for each message, like a parcel
tracking number. Every attempt at the same message uses the same reference. Email and
text-message services remember the references they have already handled, so when the
second worker sends it again, the service answers "already delivered, nothing to do",
and the customer gets **one** email. The second worker then records it as SENT.

So the honest description of our guarantee is: **one worker at a time, plus a fixed
reference number on every attempt, gives exactly one delivery**, as long as the delivery
service honours reference numbers. Most real email and SMS services do. Our stand-in
delivery service does too, and we test this exact crash.

### A late worker cannot overwrite a newer result

If a worker was merely slow rather than crashed, its claim expires and another worker
takes over. Every claim carries a unique **claim ticket**, and the ledger only accepts a
result from the worker holding the current ticket. The slow worker's late "sent" report
is politely ignored rather than overwriting the new worker's result.

## 5. Urgent notifications go first

Every notification is **HIGH**, **NORMAL** or **LOW** priority. When workers ask what is
due, the ledger hands out high-priority messages first, then normal, then low. Within the
same priority, the one that has waited longest goes first. It is the express lane at a
supermarket: when several messages are due together, the urgent ones jump ahead.

## 6. When sending fails: retries

Delivery services have bad moments: a timeout, a brief outage. When a send fails for a
reason that might clear up, the message goes back into the queue to try again later. Each
wait is longer than the last:

| After failure number | Waits roughly |
| --- | --- |
| 1 | ½ to 1 second |
| 2 | 1 to 2 seconds |
| 3 | 2 to 4 seconds |
| 4 | 4 to 8 seconds |
| 5 | 8 to 16 seconds |

(Waits never go above one minute, and all of these numbers can be changed.)

- **Why wait longer each time?** If the service is struggling, hammering it with instant
  retries makes things worse. Backing off gives it room to recover.
- **Why "roughly"?** Suppose a hundred messages all failed together during one outage.
  If every one retried at exactly the same moment, they would all hit the service at once
  and probably all fail again. Adding a little randomness spreads them out.

By default a message gets **six attempts** in total: the first try plus five retries.

Some failures are never worth retrying, such as an email address that does not exist.
Those are marked **FAILED** straight away.

## 7. Giving up safely: the dead-letter queue

When a message has used all its attempts and still failed, it is not retried forever and
it is not thrown away. It is marked **DEAD_LETTERED** and set aside, like a post office's
shelf of undeliverable mail.

- It keeps its full history: how many attempts, and the last error.
- It shows up in the numbers (`/metrics`), and a status update is sent (section 11).
- Anyone can **list** the set-aside messages.
- An operator can **send one back** to try again (section 13), for example once an
  outage is over.

We keep FAILED and DEAD_LETTERED separate on purpose. FAILED means "the service said no",
so something needs fixing first. DEAD_LETTERED means "the service kept being unavailable",
so trying again later may well work.

## 8. Problem notifications ("poison messages")

A "poison message" is one that can never succeed. The danger is that it retries forever,
or keeps crashing workers. Every kind ends somewhere safe:

| Kind of problem | What happens |
| --- | --- |
| The request itself is nonsense (bad date, unknown channel, far too large) | Rejected at the front desk; it never enters the queue |
| The delivery service always refuses it | Marked FAILED after one try |
| The delivery service keeps timing out on it | Retried with growing waits, then set aside as DEAD_LETTERED |
| It crashes the worker that picks it up | Each crash still counts as a used attempt, so after a bounded number of crashes it is set aside as DEAD_LETTERED. Other messages that worker was holding are recovered and sent normally |

## 9. The same request sent twice

Networks are unreliable. A business might send "schedule this email", not get a reply
in time, and send it again. Without protection, the customer would get two emails.

So every request carries an **idempotency key**. That is a technical name for a unique
order number the business chooses, such as `welcome-ada-2026`.

- **First time** a key is seen: the notification is scheduled, and the reply is
  **201 Created**.
- **Same key and same details again**: nothing new is scheduled, and the reply is
  **200 OK** with the original notification. This holds even if the two copies arrive at
  exactly the same instant.
- **Same key but different details**: the reply is **409 Conflict**. Reusing an order
  number for a different order is almost certainly a mistake, so we say so rather than
  guess.

We tested twenty-five identical requests arriving at once: exactly one notification was
created.

## 10. Not flooding one person: rate limiting

No one wants forty texts in an hour. Each recipient can receive at most a set number of
notifications in any rolling hour: ten by default, and both numbers can be changed.

- **"Rolling" matters.** A simple "per calendar hour" rule would allow ten at 12:59 and ten
  more at 13:00: twenty in two minutes. We count the last sixty minutes from *right now*,
  so that cannot happen.
- **Extra messages wait; they are not failed.** A message over the limit goes back into
  the queue, due at the exact moment a slot frees up, and waiting does not use up one of
  its attempts.
- **Workers take turns per recipient.** Two workers checking the same person at the same
  instant could both see "one slot left" and both send. To prevent that, a worker takes a
  brief turn on that recipient while it checks, like a single key to a room.

## 11. Telling other systems what happened: webhooks

When a notification is **SENT**, **FAILED** or **DEAD_LETTERED**, Notify Queue sends a short
status update to a web address the business provides. That is called a **webhook**. The
update looks like:

```json
{ "eventId": "0b7f6d2e-…", "jobId": "3f6c2b0e-…", "status": "SENT",
  "attemptCount": 2, "timestamp": "2026-09-24T12:01:03Z" }
```

- **An update is never lost.** The update is written into the ledger in the same step as
  the status change itself, so if a computer crashes in between, the update is still
  there and is sent afterwards.
- **If the business's system is down, we retry**, with growing waits, up to ten times.
- **Updates can occasionally arrive twice**, for example if we sent one and crashed before
  noting that. Each update carries a unique `eventId`, so the receiving system can ignore
  one it has already seen. This is called "at least once" delivery, and it is the honest
  promise for this kind of message.
- **A broken webhook never affects the notification itself.** A notification that was sent
  stays SENT even if its status update is struggling to get through.

## 12. Checking on things: status, lists and numbers

| To find out… | Ask… |
| --- | --- |
| What happened to one notification | `GET /notifications/{id}`: its status, attempts, last error and times |
| Which notifications are in a given state, or for a given person | `GET /notifications?status=DEAD_LETTERED` or `?recipient=ada@example.com`, newest first, in pages |
| How the whole system is doing | `GET /metrics`: how many are pending, sent, failed, dead-lettered and cancelled, plus how long the oldest waiting message has been waiting |
| Whether the service is up | `GET /health` |

The "oldest waiting message" number (queue lag) is the one to watch. If it keeps
growing, the workers are not keeping up, and it is time to add more.

## 13. Cancelling and re-trying by hand

- **Cancel** (`DELETE /notifications/{id}`): a notification that has not started sending
  can be cancelled, and then it is never sent. If a worker has already picked it up, the
  answer is "too late" (409), and it goes out. The system guarantees it is one or the
  other, never both: we tested 200 cancel-versus-send races happening at once. Cancelling
  something already cancelled is harmless.
- **Re-try** (`POST /notifications/{id}/retry`): sends a DEAD_LETTERED or FAILED
  notification back into the queue with a fresh set of attempts, for example after an
  outage. Each re-try is counted and timestamped on the notification, so there is a
  record of who needed a second chance and when.

## 14. When things break

| What goes wrong | What happens |
| --- | --- |
| The same request arrives twice | One notification (section 9) |
| A worker crashes before taking anything | Nothing lost; another worker takes the messages |
| A worker crashes while holding messages | After five minutes they are handed to another worker |
| A worker crashes just after the email went out | Sent again with the same reference; the delivery service recognises it; one email (section 4) |
| A worker crashes on a message's last attempt | It gets one final re-check with the same reference, rather than being wrongly marked as failed |
| The delivery service is down | Retries with growing waits, then set aside (sections 6 and 7) |
| The delivery service hangs | Each attempt is cut off after ten seconds and counted as a failure |
| The business's webhook address is down | Status updates retried; notifications unaffected |
| Someone cancels just as a worker takes the message | Exactly one wins |
| The database is unreachable | Requests get an error; `/health` reports the problem; workers keep trying until it is back |
| A worker is shut down on purpose | It finishes what it is sending, hands back what it had not started, then stops |

## 15. Growing to millions of notifications

**What grows easily.** Workers hold nothing of their own, so adding more simply adds
capacity. Because each worker skips messages another has taken, they do not slow each
other down.

**What would break first, and the fix, in order:**

1. **Database connections.** Each worker keeps a few open connections to the database,
   and databases handle a few hundred well but not thousands. The standard fix is a
   connection pooler, which lets many workers share fewer connections.
2. **Workers crowding the front of the queue.** With hundreds of workers all asking for
   "the next due messages", they spend more time stepping around each other. The fix is to
   split the queue into lanes (shards), with each worker mostly serving its own lane.
3. **One very popular recipient.** If thousands of messages wait for one person, workers
   keep picking them up, finding the limit reached, and putting them back. It is correct
   but wasteful. The fix is to have workers skip recipients who are known to be at their
   limit.
4. **Sheer history.** Millions of old, finished notifications make the ledger large. The
   fix is to archive or split old records by date. Waiting messages are already stored
   separately in a way that stays fast however large the history grows.

**When to move beyond one database.** One database handles thousands of notifications per
second, which covers most businesses. Past that, a dedicated message system (Amazon SQS,
RabbitMQ or Kafka) takes over the queue job. Each gives up something this design gets
for free, notably recording "status changed" and "send an update" in one safe step. So
the move is worth making only when the numbers demand it.

## 16. Simplifying assumptions

To keep the assessment focused, we made these assumptions. Each says why it is fair and
what a real deployment would do.

| We assumed… | Why that is fair here | In a real deployment |
| --- | --- | --- |
| **Delivery services honour reference numbers**, so a repeated send is recognised | Most real email and SMS services support this, and the "one delivery" promise depends on it | Use each service's reference feature; where one has none, the honest promise is "at least once" |
| **Sending is simulated.** A stand-in service fails at random at an adjustable rate, and always refuses addresses starting with "invalid" | The brief asks for a stand-in with random failures | Real email, SMS and push services behind the same connection point |
| **One database does everything** | One thing to run and understand, and it scales a long way | The same, until volumes outgrow it (section 15) |
| **Messages go out within about a second** of their scheduled time, not to the millisecond | Notifications do not need split-second timing | Check more often if tighter timing is needed |
| **Priority is strict.** A constant stream of HIGH messages could keep LOW ones waiting indefinitely | The brief asks for high before low whenever both are due | Let long-waiting messages gradually move up |
| **A recipient is exactly the text given.** `Ada@x.com` and `ada@x.com` count as different people for the rate limit | Each channel has its own rules for what counts as "the same" address | Tidy up addresses per channel before saving them |
| **One rate limit for everyone**, across all channels | Matches the brief's "N per recipient per hour" | Separate limits per channel or per customer |
| **Status updates go to one address, for final outcomes only, and are not signed** | These are the status changes the brief lists | A different address per customer, plus a signature proving each update came from us |
| **Set-aside (dead-lettered) messages stay in the main ledger**, marked by their status | Easy to search, and their history stays in one place | The same, with re-tries limited to authorised staff |
| **No logins or separate customers.** Anyone who can reach the service can use it | Outside the scope of the brief | Logins, per-customer data and per-customer limits |
| **Message content is not checked** beyond basic shape and size (up to 64 KB) | We carry messages; the delivery service formats them | Check content per channel, such as text-message length limits |
| **Messages can be scheduled up to a year ahead**; a time in the past means "send now" | Catches typos like the year 2099 while tolerating small clock differences | Adjustable per customer |
| **The database's clock is the one clock** for every "is it due yet?" decision | Different computers' clocks drift; one clock removes the argument | The same |

## 17. Choices we made, and what they cost

| We chose… | Instead of… | Because… | The cost |
| --- | --- | --- | --- |
| A database as the queue | A separate message system | One thing to run; status, duplicates, limits and updates all stay consistent together | Eventually needs sharding or a message system at very large scale |
| Counting an attempt when a message is picked up | Counting only when it fails | A message that crashes every worker still runs out of attempts | Attempts that never started (rate limit, shutdown) have to be handed back |
| A rolling-hour rate limit | Per-calendar-hour counting | No burst of double the limit around the hour mark | Keeps a small record per sent message, cleaned up regularly |
| Writing status updates into the ledger first | Sending them straight away | A crash can never lose one | Updates can occasionally arrive twice (each has an ID to spot repeats) |
| Rejecting a reused order number with different details | Quietly returning the old notification | A reused number is almost always a bug worth surfacing | The business must pick new numbers for new notifications |
| One extra re-check when a last attempt's worker crashes | Marking it failed at once | The email may actually have gone out; one re-check with the same reference settles it | At most one extra attempt per notification |

## 18. A few words, explained

| Word | Meaning |
| --- | --- |
| **API** | The front door other systems use to talk to Notify Queue |
| **Job** | One notification waiting to be sent, with its schedule and history |
| **Worker** | A program that picks up due notifications and sends them; many can run at once |
| **Queue** | The list of notifications waiting their turn |
| **Claim** | A worker taking a notification so no other worker can |
| **Lease / visibility timeout** | How long a claim lasts before the system assumes the worker is gone (five minutes) |
| **Idempotency key** | A unique order number from the business, so a repeated request does not create a second notification |
| **Retry / backoff** | Trying again later, waiting a little longer each time |
| **Dead-letter queue** | The shelf of notifications that could not be delivered after every attempt |
| **Poison message** | A notification that can never succeed and must not loop forever |
| **Rate limit** | The cap on how many notifications one person can receive per hour |
| **Webhook** | A status update Notify Queue sends to the business's own system |
| **At least once** | A promise that something will arrive, possibly twice, never zero times |
| **Metrics** | Headline numbers about how the system is doing |
