import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { WorkerService } from '../../src/workers/worker.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import { AlwaysFailProvider, AlwaysSuccessProvider } from '../support/test-providers.js';
import { runUntilSettled } from '../support/worker-helpers.js';

const UNKNOWN_ID = '3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c';

describe('Cancel, redrive and list (HTTP + PostgreSQL)', () => {
  let dataSource: DataSource;
  let jobs: NotificationJobRepository;
  let app: NestExpressApplication | undefined;

  const start = async (
    provider = new AlwaysSuccessProvider(),
    env: Record<string, string> = {},
  ) => {
    app = await createTestApp({
      provider,
      env: { BASE_RETRY_DELAY_MS: '1', MAX_RETRY_DELAY_MS: '2', ...env },
    });
    return { http: request(app.getHttpServer()), worker: app.get(WorkerService) };
  };

  /** Drives a job to DEAD_LETTERED through the real worker with a failing provider. */
  const deadLetter = async (worker: WorkerService) => {
    const { job } = await jobs.insertIfAbsent(newJob({ maxAttempts: 2 }));
    await runUntilSettled(worker, dataSource);
    return job.id;
  };

  const eventsFor = (jobId: string): Promise<{ status: string; redrive_count: number }[]> =>
    dataSource.query(
      'SELECT status, redrive_count FROM webhook_events WHERE job_id = $1 ORDER BY created_at',
      [jobId],
    );

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

  describe('DELETE /notifications/:id', () => {
    it('cancels a pending job, which is then never delivered', async () => {
      const provider = new AlwaysSuccessProvider();
      const { http, worker } = await start(provider);
      const { job } = await jobs.insertIfAbsent(newJob());

      const res = await http.delete(`/notifications/${job.id}`).expect(200);
      await worker.poll();
      await worker.whenIdle();

      expect(res.body).toMatchObject({ id: job.id, status: 'CANCELLED' });
      expect(res.body.cancelledAt).toEqual(expect.any(String));
      expect(provider.calls).toHaveLength(0);
      expect((await jobs.findById(job.id))?.status).toBe(JobStatus.Cancelled);
      expect(await eventsFor(job.id)).toEqual([]);
    });

    it('is safe to repeat', async () => {
      const { http } = await start();
      const { job } = await jobs.insertIfAbsent(newJob());

      const first = await http.delete(`/notifications/${job.id}`).expect(200);
      const again = await http.delete(`/notifications/${job.id}`).expect(200);

      expect(again.body).toEqual(first.body);
    });

    it('refuses once a worker has claimed the job', async () => {
      const { http } = await start();
      const { job } = await jobs.insertIfAbsent(newJob());
      await jobs.claimDueJobs('worker-a', 1);

      const res = await http.delete(`/notifications/${job.id}`).expect(409);

      expect(res.body.message).toMatch(/is PROCESSING; only PENDING jobs can be cancelled/);
    });

    it('refuses a finished job', async () => {
      const { http, worker } = await start();
      const { job } = await jobs.insertIfAbsent(newJob());
      await runUntilSettled(worker, dataSource);

      await http.delete(`/notifications/${job.id}`).expect(409);
      expect((await jobs.findById(job.id))?.status).toBe(JobStatus.Sent);
    });

    it('returns 404 for an unknown job and 400 for a malformed ID', async () => {
      const { http } = await start();

      await http.delete(`/notifications/${UNKNOWN_ID}`).expect(404);
      await http.delete('/notifications/nope').expect(400);
    });
  });

  describe('POST /notifications/:id/retry', () => {
    it('redrives a dead-lettered job with a fresh budget, and it is delivered', async () => {
      const failing = await start(new AlwaysFailProvider(true));
      const id = await deadLetter(failing.worker);
      expect((await jobs.findById(id))?.status).toBe(JobStatus.DeadLettered);
      await app?.close();

      const provider = new AlwaysSuccessProvider();
      const { http, worker } = await start(provider);
      const res = await http.post(`/notifications/${id}/retry`).expect(200);

      expect(res.body).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 6,
        redriveCount: 1,
        deadLetteredAt: null,
        lastError: 'Provider unavailable',
      });
      expect(res.body.lastRedrivenAt).toEqual(expect.any(String));

      await runUntilSettled(worker, dataSource);
      const sent = await jobs.findById(id);
      expect([sent?.status, sent?.attemptCount, sent?.redriveCount]).toEqual([
        JobStatus.Sent,
        1,
        1,
      ]);
      expect(provider.calls.map((c) => c.deliveryKey)).toEqual([id]);
      expect(await eventsFor(id)).toEqual([
        { status: 'DEAD_LETTERED', redrive_count: 0 },
        { status: 'SENT', redrive_count: 1 },
      ]);
    });

    it('lets a redriven job dead-letter again, with a second webhook event', async () => {
      const { http, worker } = await start(new AlwaysFailProvider(true), { MAX_RETRIES: '1' });
      const id = await deadLetter(worker);

      await http.post(`/notifications/${id}/retry`).expect(200);
      await runUntilSettled(worker, dataSource);

      const dead = await jobs.findById(id);
      expect([dead?.status, dead?.redriveCount]).toEqual([JobStatus.DeadLettered, 1]);
      expect(await eventsFor(id)).toEqual([
        { status: 'DEAD_LETTERED', redrive_count: 0 },
        { status: 'DEAD_LETTERED', redrive_count: 1 },
      ]);
    });

    it('redrives a permanently failed job too', async () => {
      const { http, worker } = await start(new AlwaysFailProvider(false));
      const { job } = await jobs.insertIfAbsent(newJob());
      await runUntilSettled(worker, dataSource);
      expect((await jobs.findById(job.id))?.status).toBe(JobStatus.Failed);

      const res = await http.post(`/notifications/${job.id}/retry`).expect(200);

      expect(res.body).toMatchObject({ status: 'PENDING', failedAt: null, redriveCount: 1 });
    });

    it.each([
      ['pending', async () => (await jobs.insertIfAbsent(newJob())).job.id, 'PENDING'],
      [
        'sent',
        async (worker: WorkerService) => {
          const { job } = await jobs.insertIfAbsent(newJob());
          await runUntilSettled(worker, dataSource);
          return job.id;
        },
        'SENT',
      ],
    ])('refuses a %s job with 409', async (_, make, status) => {
      const { http, worker } = await start();
      const id = await make(worker);

      const res = await http.post(`/notifications/${id}/retry`).expect(409);

      expect(res.body.message).toContain(`is ${status}`);
    });

    it('returns 404 for an unknown job', async () => {
      const { http } = await start();

      await http.post(`/notifications/${UNKNOWN_ID}/retry`).expect(404);
    });
  });

  describe('GET /notifications', () => {
    it('lists newest first and filters by status and recipient', async () => {
      const { http } = await start();
      const a = await jobs.insertIfAbsent(newJob({ recipient: 'a@example.com' }));
      const b = await jobs.insertIfAbsent(newJob({ recipient: 'b@example.com' }));
      const c = await jobs.insertIfAbsent(newJob({ recipient: 'a@example.com' }));
      await http.delete(`/notifications/${c.job.id}`).expect(200);

      const all = await http.get('/notifications').expect(200);
      const cancelled = await http.get('/notifications?status=CANCELLED').expect(200);
      const forA = await http.get('/notifications?recipient=a@example.com').expect(200);
      const pendingForA = await http
        .get('/notifications?recipient=a@example.com&status=PENDING')
        .expect(200);

      const ids = (res: request.Response) =>
        (res.body.items as { id: string }[]).map((item) => item.id);
      expect(ids(all)).toEqual([c.job.id, b.job.id, a.job.id]);
      expect(ids(cancelled)).toEqual([c.job.id]);
      expect(ids(forA)).toEqual([c.job.id, a.job.id]);
      expect(ids(pendingForA)).toEqual([a.job.id]);
      expect(all.body.nextCursor).toBeNull();
      expect(all.body.items[0]).not.toHaveProperty('payload');
    });

    it('pages through jobs with identical timestamps without skipping or repeating any', async () => {
      const { http } = await start();
      // One statement: every row gets exactly the same created_at, so only the
      // id tie-break keeps the order total.
      await dataSource.query(
        `INSERT INTO notification_jobs
           (idempotency_key, recipient, channel, payload, priority, scheduled_at,
            next_attempt_at, max_attempts)
         SELECT 'page-' || n, 'pager@example.com', 'EMAIL', '{}', 2, now(), now(), 6
           FROM generate_series(1, 23) AS n`,
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/notifications?recipient=pager@example.com&limit=5${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await http.get(url).expect(200);
        seen.push(...(res.body.items as { id: string }[]).map((item) => item.id));
        cursor = res.body.nextCursor as string | null;
        pages++;
      } while (cursor);

      const [{ total }]: { total: string }[] = await dataSource.query(
        `SELECT count(DISTINCT created_at) AS total FROM notification_jobs`,
      );
      expect(total).toBe('1');
      expect(pages).toBe(5);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
    });

    it('lists the dead-letter queue', async () => {
      const { http, worker } = await start(new AlwaysFailProvider(true));
      const id = await deadLetter(worker);
      await jobs.insertIfAbsent(newJob({ schedule: { delaySeconds: 3600 } }));

      const res = await http.get('/notifications?status=DEAD_LETTERED').expect(200);

      expect((res.body.items as { id: string }[]).map((item) => item.id)).toEqual([id]);
    });

    it.each([
      ['an unknown status', 'status=LOST'],
      ['a page size over 100', 'limit=101'],
      ['a page size of 0', 'limit=0'],
      ['a tampered cursor', 'cursor=bm9wZQ'],
      ['an unknown parameter', 'sort=asc'],
    ])('rejects %s with 400', async (_, query) => {
      const { http } = await start();

      await http.get(`/notifications?${query}`).expect(400);
    });
  });
});
