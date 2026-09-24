import type { DataSource } from 'typeorm';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { newJob } from '../support/job.factory.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';

/**
 * Cancelling races claiming: a client cancels while workers poll. Each job
 * must end up exactly one way: cancelled and never claimed, or claimed and
 * not cancelled. Never both, and never neither.
 */
describe('cancel racing claim (PostgreSQL)', () => {
  let admin: DataSource;
  let pools: DataSource[];

  beforeAll(async () => {
    admin = await createTestDataSource();
    pools = await Promise.all(Array.from({ length: 6 }, () => createTestDataSource(3)));
  });

  afterAll(async () => {
    await Promise.all([admin.destroy(), ...pools.map((ds) => ds.destroy())]);
  });

  beforeEach(async () => {
    await truncateAll(admin);
  });

  it('resolves every one of 200 simultaneous cancel/claim races one way only', async () => {
    const jobs = new NotificationJobRepository(admin);
    const inserted = await Promise.all(
      Array.from({ length: 200 }, () => jobs.insertIfAbsent(newJob())),
    );
    const ids = inserted.map(({ job }) => job.id);
    const [cancelPool, ...workerPools] = pools;
    const canceller = new NotificationJobRepository(cancelPool);

    const claimed = new Set<string>();
    const [cancelResults] = await Promise.all([
      Promise.all(ids.map((id) => canceller.cancelPending(id))),
      ...workerPools.map(async (ds, w) => {
        const worker = new NotificationJobRepository(ds);
        for (let round = 0; round < 20; round++) {
          const { jobs: batch } = await worker.claimDueJobs(`worker-${w}`, 5);
          for (const job of batch) claimed.add(job.id);
        }
      }),
    ]);

    const cancelled = new Set(ids.filter((_, i) => cancelResults[i]));
    const rows: { id: string; status: JobStatus }[] = await admin.query(
      'SELECT id, status FROM notification_jobs',
    );

    for (const { id, status } of rows) {
      if (cancelled.has(id)) {
        expect(status).toBe(JobStatus.Cancelled);
        expect(claimed.has(id)).toBe(false);
      } else if (claimed.has(id)) {
        expect(status).toBe(JobStatus.Processing);
      } else {
        // Neither side got to it; it must still be pending.
        expect(status).toBe(JobStatus.Pending);
      }
    }
    // Both sides actually won some races, so the test exercised the race.
    expect(cancelled.size).toBeGreaterThan(0);
    expect(claimed.size).toBeGreaterThan(0);
  });
});
