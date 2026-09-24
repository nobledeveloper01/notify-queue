-- Notify Queue demo data. Idempotent: re-running inserts nothing twice
-- (every job has a fixed idempotency key; conflicts are skipped).
--
-- Run:  npm run seed                                   (local, uses .env)
--       docker compose --profile seed run --rm seed    (Docker)
--
-- Seeded jobs have no request_fingerprint (NULL), which the API treats as
-- "created before fingerprints": replaying their keys is accepted.

BEGIN;

INSERT INTO notification_jobs
  (idempotency_key, recipient, channel, payload, priority, status,
   scheduled_at, next_attempt_at, attempt_count, max_attempts,
   last_error, sent_at, failed_at, dead_lettered_at, created_at, updated_at)
VALUES
  -- Immediate: due now, delivered on the first poll.
  ('seed-immediate', 'ada@example.com', 'EMAIL',
   '{"subject": "Welcome", "body": "Your account is ready."}', 2, 'PENDING',
   now(), now(), 0, 6, NULL, NULL, NULL, NULL, now(), now()),

  -- Delayed: not due for ten minutes; stays PENDING until then.
  ('seed-delayed', 'grace@example.com', 'EMAIL',
   '{"subject": "Reminder", "body": "Your trial ends tomorrow."}', 2, 'PENDING',
   now() + interval '10 minutes', now() + interval '10 minutes', 0, 6,
   NULL, NULL, NULL, NULL, now(), now()),

  -- Priorities: all due at the same instant; claimed HIGH, then NORMAL, then LOW.
  ('seed-priority-high', '+2348012345678', 'SMS',
   '{"body": "Your one-time code is 482913."}', 3, 'PENDING',
   now(), now(), 0, 6, NULL, NULL, NULL, NULL, now(), now()),
  ('seed-priority-normal', 'linus@example.com', 'EMAIL',
   '{"subject": "Weekly digest", "body": "Three new comments."}', 2, 'PENDING',
   now(), now(), 0, 6, NULL, NULL, NULL, NULL, now(), now()),
  ('seed-priority-low', 'device-token-7f3a9c', 'PUSH',
   '{"title": "Tip", "body": "You can mute threads."}', 1, 'PENDING',
   now(), now(), 0, 6, NULL, NULL, NULL, NULL, now(), now()),

  -- Retrying: two attempts failed; the next is scheduled 30 seconds out.
  ('seed-retrying', 'margaret@example.com', 'EMAIL',
   '{"subject": "Invoice", "body": "Invoice #1042 is attached."}', 2, 'PENDING',
   now() - interval '2 minutes', now() + interval '30 seconds', 2, 6,
   'Simulated provider outage', NULL, NULL, NULL,
   now() - interval '2 minutes', now()),

  -- Will fail permanently: the mock provider rejects recipients starting "invalid".
  ('seed-will-fail', 'invalid-recipient@example.com', 'EMAIL',
   '{"subject": "Hello", "body": "This address bounces."}', 2, 'PENDING',
   now(), now(), 0, 6, NULL, NULL, NULL, NULL, now(), now()),

  -- History: one of each terminal state.
  ('seed-sent', 'alan@example.com', 'EMAIL',
   '{"subject": "Receipt", "body": "Thanks for your order."}', 2, 'SENT',
   now() - interval '2 hours', now() - interval '2 hours', 1, 6,
   NULL, now() - interval '2 hours', NULL, NULL,
   now() - interval '2 hours', now() - interval '2 hours'),
  ('seed-failed', 'invalid-old@example.com', 'EMAIL',
   '{"subject": "Hello", "body": "Rejected recipient."}', 2, 'FAILED',
   now() - interval '90 minutes', now() - interval '90 minutes', 1, 6,
   'Recipient rejected by provider', NULL, now() - interval '90 minutes', NULL,
   now() - interval '90 minutes', now() - interval '90 minutes'),
  ('seed-dead-lettered', 'katherine@example.com', 'SMS',
   '{"body": "Your parcel is out for delivery."}', 2, 'DEAD_LETTERED',
   now() - interval '1 hour', now() - interval '1 hour', 6, 6,
   'Simulated provider outage', NULL, NULL, now() - interval '1 hour',
   now() - interval '3 hours', now() - interval '1 hour')
ON CONFLICT (idempotency_key) DO NOTHING;

-- Operator actions: a job cancelled before it was sent, and a dead-lettered
-- job an operator sent back to the queue (it is due now, with a fresh budget).
INSERT INTO notification_jobs
  (idempotency_key, recipient, channel, payload, priority, status,
   scheduled_at, next_attempt_at, attempt_count, max_attempts, last_error,
   cancelled_at, redrive_count, last_redriven_at, created_at, updated_at)
VALUES
  ('seed-cancelled', 'barbara@example.com', 'EMAIL',
   '{"subject": "Flash sale", "body": "Ends tonight."}', 1, 'CANCELLED',
   now() + interval '1 hour', now() + interval '1 hour', 0, 6, NULL,
   now() - interval '5 minutes', 0, NULL,
   now() - interval '10 minutes', now() - interval '5 minutes'),
  ('seed-redriven', 'edsger@example.com', 'PUSH',
   '{"title": "Reminder", "body": "Your appointment is tomorrow."}', 2, 'PENDING',
   now() - interval '2 hours', now(), 0, 6, 'Simulated provider outage',
   NULL, 1, now(),
   now() - interval '2 hours', now())
ON CONFLICT (idempotency_key) DO NOTHING;

-- One busy recipient: twelve jobs due now against the default limit of ten
-- per hour. Ten are delivered; two wait until the first slot frees.
INSERT INTO notification_jobs
  (idempotency_key, recipient, channel, payload, priority, status,
   scheduled_at, next_attempt_at, attempt_count, max_attempts)
SELECT 'seed-busy-' || n, 'busy@example.com', 'EMAIL',
       jsonb_build_object('subject', 'Update ' || n, 'body', 'Activity on your account.'),
       2, 'PENDING', now(), now(), 0, 6
  FROM generate_series(1, 12) AS n
ON CONFLICT (idempotency_key) DO NOTHING;

-- The outbox events the terminal jobs above would have produced, already
-- delivered, keeping the invariant "terminal status <=> webhook event".
-- (Cancellation is a client action and emits no webhook.) The redriven job
-- keeps the event from before its redrive, generation 0.
INSERT INTO webhook_events
  (job_id, status, attempt_count, occurred_at, dispatch_attempts, delivered_at, redrive_count)
SELECT id,
       CASE WHEN idempotency_key = 'seed-redriven' THEN 'DEAD_LETTERED' ELSE status END,
       CASE WHEN idempotency_key = 'seed-redriven' THEN 6 ELSE attempt_count END,
       updated_at - interval '1 hour', 1, updated_at - interval '1 hour' + interval '1 second', 0
  FROM notification_jobs
 WHERE idempotency_key IN ('seed-sent', 'seed-failed', 'seed-dead-lettered', 'seed-redriven')
ON CONFLICT (job_id, status, redrive_count) DO NOTHING;

COMMIT;
