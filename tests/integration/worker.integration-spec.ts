import { setTimeout as sleep } from 'node:timers/promises';
import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { JobPriority } from '../../src/common/enums/job-priority.enum.js';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import type { NotificationProvider } from '../../src/delivery/providers/notification-provider.interface.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';
import { WorkerRecoveryService } from '../../src/workers/worker-recovery.service.js';
import { WorkerService } from '../../src/workers/worker.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import {
  AlwaysFailProvider,
  AlwaysSuccessProvider,
  FailNTimesProvider,
  HangingProvider,
  RecordingProvider,
  ThrowingProvider,
} from '../support/test-providers.js';
import { countByStatus, eventually, runUntilSettled } from '../support/worker-helpers.js';
import { startWebhookReceiver } from '../support/webhook-receiver.js';

/** Retries become due almost at once, so a test can run a job to its end state quickly. */
const FAST_RETRIES = { BASE_RETRY_DELAY_MS: '1', MAX_RETRY_DELAY_MS: '2' };

describe('Worker (PostgreSQL)', () => {
  let dataSource: DataSource;
  let jobs: NotificationJobRepository;
  let app: INestApplication | undefined;

  const startWorker = async (provider?: NotificationProvider, env: Record<string, string> = {}) => {
    app = await createTestApp({ provider, env: { ...FAST_RETRIES, ...env }, listen: false });
    return app.get(WorkerService);
  };

  const job = async (id: string) => {
    const found = await jobs.findById(id);
    if (!found) throw new Error(`job ${id} missing`);
    return found;
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    jobs = new NotificationJobRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('delivery outcomes', () => {
    it('delivers every due job once and leaves future jobs alone', async () => {
      const provider = new AlwaysSuccessProvider();
      const worker = await startWorker(provider);
      const due = await Promise.all([1, 2, 3].map(() => jobs.insertIfAbsent(newJob())));
      const future = await jobs.insertIfAbsent(newJob({ schedule: { delaySeconds: 3600 } }));

      await runUntilSettled(worker, dataSource);

      for (const { job: j } of due) {
        const sent = await job(j.id);
        expect(sent.status).toBe(JobStatus.Sent);
        expect(sent.attemptCount).toBe(1);
      }
      expect((await job(future.job.id)).status).toBe(JobStatus.Pending);
      expect(provider.calls.map((c) => c.deliveryKey).sort()).toEqual(
        due.map(({ job: j }) => j.id).sort(),
      );
    });

    it('retries transient failures until delivery succeeds', async () => {
      const provider = new FailNTimesProvider(2);
      const worker = await startWorker(provider);
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 6 }));

      await runUntilSettled(worker, dataSource);

      const sent = await job(j.id);
      expect(sent.status).toBe(JobStatus.Sent);
      expect(sent.attemptCount).toBe(3);
      expect(sent.lastError).toBeNull();
      expect(provider.calls).toHaveLength(3);
    });

    it('dead-letters a job whose every attempt fails, and stops retrying it', async () => {
      const provider = new AlwaysFailProvider(true);
      const worker = await startWorker(provider);
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 3 }));

      await runUntilSettled(worker, dataSource);
      await worker.poll();
      await worker.whenIdle();

      const dead = await job(j.id);
      expect(dead.status).toBe(JobStatus.DeadLettered);
      expect(dead.attemptCount).toBe(3);
      expect(dead.lastError).toBe('Provider unavailable');
      expect(dead.deadLetteredAt).toBeInstanceOf(Date);
      expect(provider.calls).toHaveLength(3);
    });

    it('fails a permanently rejected job after one attempt', async () => {
      const provider = new AlwaysFailProvider(false);
      const worker = await startWorker(provider);
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 6 }));

      await runUntilSettled(worker, dataSource);

      const failed = await job(j.id);
      expect([failed.status, failed.attemptCount, failed.lastError]).toEqual([
        JobStatus.Failed,
        1,
        'Recipient rejected',
      ]);
      expect(provider.calls).toHaveLength(1);
    });

    it('schedules the retry with exponential backoff on the database clock', async () => {
      const worker = await startWorker(new AlwaysFailProvider(true), {
        BASE_RETRY_DELAY_MS: '2000',
        MAX_RETRY_DELAY_MS: '60000',
      });
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 6 }));

      await worker.poll();
      await worker.whenIdle();

      const [{ delay_ms }]: { delay_ms: string }[] = await dataSource.query(
        `SELECT extract(epoch FROM next_attempt_at - now()) * 1000 AS delay_ms
           FROM notification_jobs WHERE id = $1`,
        [j.id],
      );
      // First failure: base 2000ms with equal jitter → between 1000 and 2000ms.
      expect(Number(delay_ms)).toBeGreaterThan(900);
      expect(Number(delay_ms)).toBeLessThanOrEqual(2000);
      expect((await job(j.id)).status).toBe(JobStatus.Pending);
    });

    it('treats a provider that throws as a retryable failure', async () => {
      const worker = await startWorker(new ThrowingProvider());
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 6 }));

      await worker.poll();
      await worker.whenIdle();

      const retried = await job(j.id);
      expect([retried.status, retried.lastError]).toEqual([JobStatus.Pending, 'socket hang up']);
    });

    it('times out a provider that never answers and retries the job', async () => {
      const worker = await startWorker(new HangingProvider(), { PROVIDER_TIMEOUT_MS: '100' });
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 6 }));

      await worker.poll();
      await worker.whenIdle();

      const retried = await job(j.id);
      expect([retried.status, retried.lastError]).toEqual([
        JobStatus.Pending,
        'Provider timed out after 100ms',
      ]);
    });
  });

  describe('concurrency control', () => {
    it('never runs more deliveries at once than WORKER_CONCURRENCY', async () => {
      const provider = new RecordingProvider(40);
      const worker = await startWorker(provider, { WORKER_CONCURRENCY: '3' });
      await Promise.all(Array.from({ length: 12 }, () => jobs.insertIfAbsent(newJob())));

      await runUntilSettled(worker, dataSource);

      expect(provider.maxInFlight).toBe(3);
      expect(await countByStatus(dataSource)).toEqual({ SENT: 12 });
    });

    it('holds at most WORKER_BATCH_SIZE claimed jobs, however much work is due', async () => {
      const provider = new RecordingProvider(100);
      const worker = await startWorker(provider, {
        WORKER_CONCURRENCY: '2',
        WORKER_BATCH_SIZE: '5',
      });
      await Promise.all(Array.from({ length: 12 }, () => jobs.insertIfAbsent(newJob())));

      const first = await worker.poll();
      const second = await worker.poll();

      expect(first).toEqual({ requested: 5, claimed: 5 });
      expect(second).toEqual({ requested: 0, claimed: 0 });
      expect(worker.activeCount).toBe(2);
      expect(await countByStatus(dataSource)).toEqual({ PROCESSING: 5, PENDING: 7 });
      await worker.whenIdle();
    });
  });

  describe('rate limiting', () => {
    it('defers jobs over the recipient limit without spending an attempt', async () => {
      const provider = new AlwaysSuccessProvider();
      const worker = await startWorker(provider, {
        RATE_LIMIT_MAX_NOTIFICATIONS: '2',
        RATE_LIMIT_WINDOW_SECONDS: '3600',
      });
      await Promise.all(
        Array.from({ length: 5 }, () =>
          jobs.insertIfAbsent(newJob({ recipient: 'busy@example.com' })),
        ),
      );
      const other = await jobs.insertIfAbsent(newJob({ recipient: 'quiet@example.com' }));

      await worker.poll();
      await worker.whenIdle();

      expect(await countByStatus(dataSource)).toEqual({ SENT: 3, PENDING: 3 });
      expect((await job(other.job.id)).status).toBe(JobStatus.Sent);
      const deferred: { attempt_count: number; wait_s: string }[] = await dataSource.query(
        `SELECT attempt_count, extract(epoch FROM next_attempt_at - now()) AS wait_s
           FROM notification_jobs WHERE status = 'PENDING'`,
      );
      for (const row of deferred) {
        expect(row.attempt_count).toBe(0);
        expect(Number(row.wait_s)).toBeGreaterThan(3590);
      }
      expect(provider.calls.filter((c) => c.recipient === 'busy@example.com')).toHaveLength(2);
    });

    it('delivers a deferred job once its slot frees', async () => {
      const worker = await startWorker(new AlwaysSuccessProvider(), {
        RATE_LIMIT_MAX_NOTIFICATIONS: '1',
        RATE_LIMIT_WINDOW_SECONDS: '1',
      });
      const first = await jobs.insertIfAbsent(newJob({ recipient: 'busy@example.com' }));
      const second = await jobs.insertIfAbsent(newJob({ recipient: 'busy@example.com' }));

      await worker.poll();
      await worker.whenIdle();
      expect((await job(second.job.id)).status).toBe(JobStatus.Pending);

      await eventually(async () => {
        await worker.poll();
        await worker.whenIdle();
        return (await job(second.job.id)).status === JobStatus.Sent;
      }, 4000);
      expect((await job(first.job.id)).status).toBe(JobStatus.Sent);
      expect((await job(second.job.id)).attemptCount).toBe(1);
    });

    it('prunes reservations once they are outside the window', async () => {
      const worker = await startWorker(new AlwaysSuccessProvider(), {
        RATE_LIMIT_WINDOW_SECONDS: '1',
      });
      await jobs.insertIfAbsent(newJob());
      await worker.poll();
      await worker.whenIdle();
      await dataSource.query(
        `UPDATE rate_limit_reservations SET reserved_at = now() - interval '5 seconds'`,
      );

      await app?.get(WorkerRecoveryService).recoverStale();

      const [{ count }]: { count: string }[] = await dataSource.query(
        'SELECT count(*) FROM rate_limit_reservations',
      );
      expect(count).toBe('0');
    });

    it('reports how many expired reservations it pruned', async () => {
      await startWorker(new AlwaysSuccessProvider(), { RATE_LIMIT_WINDOW_SECONDS: '1' });
      // Three expired, one live. Not two: the old bug returned 2 whatever was pruned.
      const inserted = await Promise.all([1, 2, 3, 4].map(() => jobs.insertIfAbsent(newJob())));
      for (const [i, { job: j }] of inserted.entries()) {
        await dataSource.query(
          `INSERT INTO rate_limit_reservations (job_id, recipient, reserved_at)
           VALUES ($1, $2, now() - make_interval(secs => $3))`,
          [j.id, j.recipient, i === 0 ? 0 : 10],
        );
      }

      await expect(app?.get(RateLimitService).pruneExpired()).resolves.toBe(3);
    });
  });

  describe('graceful shutdown', () => {
    it('finishes running deliveries and hands unstarted jobs straight back', async () => {
      const provider = new RecordingProvider(150);
      const worker = await startWorker(provider, {
        WORKER_CONCURRENCY: '2',
        WORKER_BATCH_SIZE: '6',
      });
      await Promise.all(Array.from({ length: 6 }, () => jobs.insertIfAbsent(newJob())));
      await worker.poll();

      const report = await worker.shutdown(5000);

      expect(report).toEqual({ released: 4, abandoned: 0 });
      expect(await countByStatus(dataSource)).toEqual({ SENT: 2, PENDING: 4 });
      const [{ max }]: { max: number }[] = await dataSource.query(
        `SELECT max(attempt_count) FROM notification_jobs WHERE status = 'PENDING'`,
      );
      expect(max).toBe(0);
      expect(await worker.poll()).toEqual({ requested: 0, claimed: 0 });
    });

    it('stops waiting at the shutdown timeout and leaves the job to recovery', async () => {
      const worker = await startWorker(new RecordingProvider(300), {
        WORKER_CONCURRENCY: '1',
        WORKER_BATCH_SIZE: '1',
      });
      await jobs.insertIfAbsent(newJob());
      await worker.poll();

      const report = await worker.shutdown(20);

      expect(report).toEqual({ released: 0, abandoned: 1 });
      await worker.whenIdle();
    });
  });

  describe('crash recovery', () => {
    it('recovers a job whose worker died after the provider accepted it, without a second logical delivery', async () => {
      // The mock provider keeps its idempotency record in PostgreSQL, like a
      // real provider keeps its own: shared by every worker.
      const worker = await startWorker(undefined, { JOB_VISIBILITY_TIMEOUT_SECONDS: '60' });
      const { job: j } = await jobs.insertIfAbsent(newJob());

      // Worker "A" claims the job and the provider accepts it...
      const { claimToken } = await jobs.claimDueJobs('worker-a', 1);
      await dataSource.query(
        `INSERT INTO mock_provider_deliveries (delivery_key, recipient, channel) VALUES ($1, $2, $3)`,
        [j.id, j.recipient, j.channel],
      );
      // ...then A crashes before recording SENT. Its lease expires.
      await dataSource.query(
        `UPDATE notification_jobs SET locked_at = now() - interval '2 minutes' WHERE id = $1`,
        [j.id],
      );

      const recovered = await app?.get(WorkerRecoveryService).recoverStale();
      await runUntilSettled(worker, dataSource);

      expect(recovered?.requeued).toEqual([j.id]);
      const sent = await job(j.id);
      expect([sent.status, sent.attemptCount]).toEqual([JobStatus.Sent, 2]);
      const [{ count }]: { count: string }[] = await dataSource.query(
        'SELECT count(*) FROM mock_provider_deliveries WHERE delivery_key = $1',
        [j.id],
      );
      expect(count).toBe('1');
      await expect(jobs.markSent(j.id, claimToken)).resolves.toBe(false);
    });
  });

  describe('failure before and after the provider call', () => {
    it('refunds the attempt when processing fails before the provider is called', async () => {
      const provider = new AlwaysSuccessProvider();
      const worker = await startWorker(provider);
      const rateLimit = app?.get(RateLimitService);
      if (!rateLimit) throw new Error('app not started');
      const admit = jest
        .spyOn(rateLimit, 'admit')
        .mockRejectedValueOnce(new Error('connection reset'));
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 1 }));

      await worker.poll();
      await worker.whenIdle();

      const handedBack = await job(j.id);
      expect([handedBack.status, handedBack.attemptCount]).toEqual([JobStatus.Pending, 0]);
      expect(provider.calls).toHaveLength(0);

      admit.mockRestore();
      await runUntilSettled(worker, dataSource);
      expect((await job(j.id)).status).toBe(JobStatus.Sent);
    });

    it('does not send a job that was reclaimed while it waited in the local queue', async () => {
      const provider = new RecordingProvider(200);
      const worker = await startWorker(provider, {
        WORKER_CONCURRENCY: '1',
        WORKER_BATCH_SIZE: '2',
      });
      const first = await jobs.insertIfAbsent(newJob({ priority: JobPriority.High }));
      const waiting = await jobs.insertIfAbsent(newJob({ priority: JobPriority.Low }));
      await worker.poll();

      // While the first delivery runs, the queued job's claim expires and
      // another worker takes it.
      await dataSource.query(
        `UPDATE notification_jobs SET locked_at = now() - interval '10 minutes' WHERE id = $1`,
        [waiting.job.id],
      );
      await jobs.recoverStaleClaims(300, 100);
      const other = await jobs.claimDueJobs('worker-b', 1);
      await worker.whenIdle();

      expect(provider.calls.map((c) => c.deliveryKey)).toEqual([first.job.id]);
      const reclaimed = await job(waiting.job.id);
      expect([reclaimed.status, reclaimed.lockedBy, reclaimed.claimToken]).toEqual([
        JobStatus.Processing,
        'worker-b',
        other.claimToken,
      ]);
    });

    it('reconciles a final attempt the provider accepted before the worker died', async () => {
      const worker = await startWorker(undefined, { JOB_VISIBILITY_TIMEOUT_SECONDS: '60' });
      const { job: j } = await jobs.insertIfAbsent(newJob({ maxAttempts: 1 }));
      await jobs.claimDueJobs('worker-a', 1);
      await dataSource.query(
        `INSERT INTO mock_provider_deliveries (delivery_key, recipient, channel) VALUES ($1, $2, $3)`,
        [j.id, j.recipient, j.channel],
      );
      await dataSource.query(
        `UPDATE notification_jobs SET locked_at = now() - interval '2 minutes' WHERE id = $1`,
        [j.id],
      );

      await app?.get(WorkerRecoveryService).recoverStale();
      await runUntilSettled(worker, dataSource);

      const settled = await job(j.id);
      expect([settled.status, settled.attemptCount]).toEqual([JobStatus.Sent, 2]);
      const [{ count }]: { count: string }[] = await dataSource.query(
        'SELECT count(*) FROM mock_provider_deliveries WHERE delivery_key = $1',
        [j.id],
      );
      expect(count).toBe('1');
    });
  });

  describe('scheduler', () => {
    it('polls and delivers on its own when APP_ROLE=worker, and drains on shutdown', async () => {
      const provider = new AlwaysSuccessProvider();
      await startWorker(provider, { APP_ROLE: 'worker', WORKER_POLL_INTERVAL_MS: '20' });
      const { job: j } = await jobs.insertIfAbsent(newJob());

      await eventually(async () => (await job(j.id)).status === JobStatus.Sent);
      expect(provider.calls).toHaveLength(1);
    });

    it('lets an in-flight webhook dispatch finish before closing the pool', async () => {
      const receiver = await startWebhookReceiver(() => 200, 400);
      try {
        await startWorker(new AlwaysSuccessProvider(), {
          APP_ROLE: 'worker',
          WORKER_POLL_INTERVAL_MS: '20',
          WEBHOOK_URL: receiver.url,
          WEBHOOK_POLL_INTERVAL_MS: '20',
        });
        const { job: j } = await jobs.insertIfAbsent(newJob());
        await eventually(() => Promise.resolve(receiver.received.length === 1));

        await app?.close();
        app = undefined;

        const [event]: { delivered_at: Date | null }[] = await dataSource.query(
          'SELECT delivered_at FROM webhook_events WHERE job_id = $1',
          [j.id],
        );
        expect(event.delivered_at).toBeInstanceOf(Date);
      } finally {
        await receiver.close();
      }
    });

    it('does not poll when APP_ROLE=api', async () => {
      const provider = new AlwaysSuccessProvider();
      await startWorker(provider, { APP_ROLE: 'api', WORKER_POLL_INTERVAL_MS: '20' });
      const { job: j } = await jobs.insertIfAbsent(newJob());

      await sleep(200);

      expect((await job(j.id)).status).toBe(JobStatus.Pending);
      expect(provider.calls).toHaveLength(0);
    });
  });
});
