import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { WorkerService } from '../../src/workers/worker.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import { RecordingProvider } from '../support/test-providers.js';
import { countByStatus } from '../support/worker-helpers.js';

/**
 * Each simulated worker gets its own DataSource (its own connection pool), as
 * separate worker processes would. The race happens inside PostgreSQL.
 */
interface SimulatedWorker {
  id: string;
  dataSource: DataSource;
  repository: NotificationJobRepository;
}

const WORKER_COUNT = 10;

describe('duplicate delivery under concurrent workers (PostgreSQL)', () => {
  let admin: DataSource;
  let adminRepository: NotificationJobRepository;
  let workers: SimulatedWorker[];

  beforeAll(async () => {
    admin = await createTestDataSource();
    adminRepository = new NotificationJobRepository(admin);
    workers = await Promise.all(
      Array.from({ length: WORKER_COUNT }, async (_, i) => {
        const dataSource = await createTestDataSource(2);
        return {
          id: `worker-${i}`,
          dataSource,
          repository: new NotificationJobRepository(dataSource),
        };
      }),
    );
  });

  afterAll(async () => {
    await Promise.all([admin.destroy(), ...workers.map((w) => w.dataSource.destroy())]);
  });

  beforeEach(async () => {
    await truncateAll(admin);
  });

  it('gives one job to exactly one of 10 simultaneous claimers, round after round', async () => {
    const rounds = 25;

    for (let round = 0; round < rounds; round++) {
      await truncateAll(admin);
      const { job } = await adminRepository.insertIfAbsent(newJob());

      const claims = await Promise.all(
        workers.map(async (w) => ({ worker: w, batch: await w.repository.claimDueJobs(w.id, 1) })),
      );
      const winners = claims.filter(({ batch }) => batch.jobs.length > 0);

      expect(winners).toHaveLength(1);
      expect(winners[0].batch.jobs[0].id).toBe(job.id);

      // Every worker then tries to report delivery; only the owner's counts.
      const reports = await Promise.all(
        claims.map(({ worker: w, batch: b }) => w.repository.markSent(job.id, b.claimToken)),
      );
      expect(reports.filter(Boolean)).toHaveLength(1);

      const final = await adminRepository.findById(job.id);
      expect(final?.status).toBe(JobStatus.Sent);
      expect(final?.attemptCount).toBe(1);
      expect(final?.lockedBy).toBeNull();
    }
  });

  it('drains 500 jobs across 10 polling workers with every job delivered exactly once', async () => {
    const total = 500;
    const inserted = await Promise.all(
      Array.from({ length: total }, () => adminRepository.insertIfAbsent(newJob())),
    );

    const deliveries = new Map<string, string[]>();
    const claimedByWorker = new Map<string, number>();

    const runWorker = async (w: SimulatedWorker): Promise<void> => {
      for (;;) {
        const { claimToken, jobs } = await w.repository.claimDueJobs(w.id, 7);
        if (jobs.length === 0) return;
        claimedByWorker.set(w.id, (claimedByWorker.get(w.id) ?? 0) + jobs.length);
        for (const job of jobs) {
          deliveries.set(job.id, [...(deliveries.get(job.id) ?? []), w.id]);
          await w.repository.markSent(job.id, claimToken);
        }
      }
    };
    await Promise.all(workers.map(runWorker));

    const expectedIds = inserted.map(({ job }) => job.id).sort();
    expect([...deliveries.keys()].sort()).toEqual(expectedIds);
    const duplicated = [...deliveries].filter(([, by]) => by.length > 1);
    expect(duplicated).toEqual([]);

    const [{ count }]: { count: string }[] = await admin.query(
      `SELECT count(*) FROM notification_jobs WHERE status = 'SENT' AND attempt_count = 1`,
    );
    expect(Number(count)).toBe(total);

    // SKIP LOCKED spreads the work instead of serialising it behind one worker.
    expect(claimedByWorker.size).toBeGreaterThan(1);
  });

  /**
   * Control experiment: the same race with a naive read-then-write claim
   * (no row lock, no status guard on the UPDATE). A short pause between the
   * read and the write widens the window a real network or GC pause would
   * open. Several workers "claim" the same job, which is exactly the bug
   * FOR UPDATE SKIP LOCKED prevents.
   */
  it('control: a naive SELECT-then-UPDATE claim hands one job to many workers', async () => {
    await adminRepository.insertIfAbsent(newJob());

    const naiveClaim = async (w: SimulatedWorker): Promise<boolean> => {
      const due: { id: string }[] = await w.dataSource.query(
        `SELECT id FROM notification_jobs WHERE status = 'PENDING' LIMIT 1`,
      );
      if (due.length === 0) return false;
      await w.dataSource.query('SELECT pg_sleep(0.05)');
      await w.dataSource.query(
        `UPDATE notification_jobs
            SET status = 'PROCESSING', locked_by = $2, locked_at = now(),
                claim_token = gen_random_uuid()
          WHERE id = $1`,
        [due[0].id, w.id],
      );
      return true;
    };

    const results = await Promise.all(workers.map(naiveClaim));

    expect(results.filter(Boolean).length).toBeGreaterThan(1);
  });
});

/**
 * The spec's scenario end to end: ten complete worker applications (each its
 * own Nest app, worker ID and connection pool) sharing one provider, polling
 * at the same moment. Checked on both sides: the database, and how many
 * times the provider was actually called.
 */
describe('duplicate delivery with 10 real worker applications (PostgreSQL)', () => {
  let admin: DataSource;
  let jobs: NotificationJobRepository;
  let provider: RecordingProvider;
  let apps: INestApplication[];
  let workers: WorkerService[];

  beforeAll(async () => {
    admin = await createTestDataSource();
    jobs = new NotificationJobRepository(admin);
    provider = new RecordingProvider(5);
    apps = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      apps.push(
        await createTestApp({
          provider,
          listen: false,
          env: { WORKER_ID: `app-worker-${i}`, DATABASE_POOL_MAX: '3', WORKER_CONCURRENCY: '5' },
        }),
      );
    }
    workers = apps.map((a) => a.get(WorkerService));
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await admin.destroy();
  });

  beforeEach(async () => {
    await truncateAll(admin);
    provider.calls.length = 0;
  });

  it('1 job, 10 workers polling simultaneously: 1 provider call, 1 delivery', async () => {
    const { job } = await jobs.insertIfAbsent(newJob());

    const polls = await Promise.all(workers.map((w) => w.poll()));
    await Promise.all(workers.map((w) => w.whenIdle()));

    expect(polls.map((p) => p.claimed).reduce((a, b) => a + b)).toBe(1);
    expect(provider.calls.map((c) => c.deliveryKey)).toEqual([job.id]);
    const sent = await jobs.findById(job.id);
    expect([sent?.status, sent?.attemptCount]).toEqual([JobStatus.Sent, 1]);
  });

  it('300 jobs across 10 workers: exactly 300 provider calls, all SENT on the first attempt', async () => {
    await Promise.all(Array.from({ length: 300 }, () => jobs.insertIfAbsent(newJob())));

    for (let round = 0; round < 50; round++) {
      const polls = await Promise.all(workers.map((w) => w.poll()));
      await Promise.all(workers.map((w) => w.whenIdle()));
      if (polls.every((p) => p.claimed === 0)) break;
    }

    expect(provider.calls).toHaveLength(300);
    expect(new Set(provider.calls.map((c) => c.deliveryKey)).size).toBe(300);
    expect(await countByStatus(admin)).toEqual({ SENT: 300 });
    const [{ max }]: { max: number }[] = await admin.query(
      'SELECT max(attempt_count) FROM notification_jobs',
    );
    expect(max).toBe(1);
  });
});
