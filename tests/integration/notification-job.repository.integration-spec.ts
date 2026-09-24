import type { DataSource } from 'typeorm';
import { JobPriority } from '../../src/common/enums/job-priority.enum.js';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationJob } from '../../src/notifications/entities/notification-job.entity.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { newJob } from '../support/job.factory.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';

describe('NotificationJobRepository (PostgreSQL)', () => {
  let dataSource: DataSource;
  let repository: NotificationJobRepository;

  /** Pretend the claim on `id` was taken `seconds` ago. */
  const ageClaim = (id: string, seconds: number) =>
    dataSource.query(
      `UPDATE notification_jobs SET locked_at = locked_at - make_interval(secs => $2) WHERE id = $1`,
      [id, seconds],
    );

  const reload = async (id: string): Promise<NotificationJob> => {
    const job = await repository.findById(id);
    if (!job) throw new Error(`job ${id} missing`);
    return job;
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    repository = new NotificationJobRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  describe('schema', () => {
    it('matches the entity column for column', async () => {
      const rows: { column_name: string; is_nullable: 'YES' | 'NO' }[] = await dataSource.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'notification_jobs'`,
      );
      const actual = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable === 'YES']));
      const expected = Object.fromEntries(
        dataSource.getMetadata(NotificationJob).columns.map((c) => [c.databaseName, c.isNullable]),
      );

      expect(actual).toEqual(expected);
    });

    it('rejects a PROCESSING row with no claim owner', async () => {
      const { job } = await repository.insertIfAbsent(newJob());

      await expect(
        dataSource.query(`UPDATE notification_jobs SET status = 'PROCESSING' WHERE id = $1`, [
          job.id,
        ]),
      ).rejects.toThrow(/ck_notification_jobs_claim/);
    });

    it('rejects SENT without a sent_at timestamp', async () => {
      const { job } = await repository.insertIfAbsent(newJob());

      await expect(
        dataSource.query(`UPDATE notification_jobs SET status = 'SENT' WHERE id = $1`, [job.id]),
      ).rejects.toThrow(/ck_notification_jobs_sent_at/);
    });
  });

  describe('insertIfAbsent', () => {
    it('creates a pending job due at its scheduled time', async () => {
      const input = newJob({ priority: JobPriority.High });

      const { job, created } = await repository.insertIfAbsent(input);

      expect(created).toBe(true);
      expect(job.status).toBe(JobStatus.Pending);
      expect(job.priority).toBe(JobPriority.High);
      expect(job.attemptCount).toBe(0);
      expect(job.nextAttemptAt.getTime()).toBe(input.scheduledAt.getTime());
      expect(job.payload).toEqual(input.payload);
    });

    it('returns the existing job for a repeated idempotency key', async () => {
      const first = await repository.insertIfAbsent(newJob({ idempotencyKey: 'same' }));
      const second = await repository.insertIfAbsent(
        newJob({ idempotencyKey: 'same', recipient: 'someone-else@example.com' }),
      );

      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(second.job.recipient).toBe('user@example.com');
    });
  });

  describe('claimDueJobs', () => {
    it('claims by priority, then by due time, and skips jobs not yet due', async () => {
      const now = Date.now();
      const low = await repository.insertIfAbsent(newJob({ priority: JobPriority.Low }));
      const normalLater = await repository.insertIfAbsent(
        newJob({ scheduledAt: new Date(now - 1_000) }),
      );
      const normalEarlier = await repository.insertIfAbsent(
        newJob({ scheduledAt: new Date(now - 60_000) }),
      );
      const high = await repository.insertIfAbsent(newJob({ priority: JobPriority.High }));
      await repository.insertIfAbsent(
        newJob({ priority: JobPriority.High, scheduledAt: new Date(now + 60_000) }),
      );

      const { jobs } = await repository.claimDueJobs('worker-a', 10);

      expect(jobs.map((j) => j.id)).toEqual([
        high.job.id,
        normalEarlier.job.id,
        normalLater.job.id,
        low.job.id,
      ]);
    });

    it('stamps owner, lease, token and counts the attempt', async () => {
      const { job } = await repository.insertIfAbsent(newJob());

      const { claimToken, jobs } = await repository.claimDueJobs('worker-a', 10);

      expect(jobs).toHaveLength(1);
      const claimed = await reload(job.id);
      expect(claimed.status).toBe(JobStatus.Processing);
      expect(claimed.lockedBy).toBe('worker-a');
      expect(claimed.lockedAt).toBeInstanceOf(Date);
      expect(claimed.claimToken).toBe(claimToken);
      expect(claimed.attemptCount).toBe(1);
    });

    it('never hands out a job that is already claimed', async () => {
      await repository.insertIfAbsent(newJob());

      const first = await repository.claimDueJobs('worker-a', 10);
      const second = await repository.claimDueJobs('worker-b', 10);

      expect(first.jobs).toHaveLength(1);
      expect(second.jobs).toHaveLength(0);
    });

    it('respects the batch size', async () => {
      for (let i = 0; i < 5; i++) await repository.insertIfAbsent(newJob());

      const { jobs } = await repository.claimDueJobs('worker-a', 2);

      expect(jobs).toHaveLength(2);
    });
  });

  describe('completing a claim', () => {
    it('marks the job SENT and releases the claim', async () => {
      const { job } = await repository.insertIfAbsent(newJob());
      const { claimToken } = await repository.claimDueJobs('worker-a', 1);

      await expect(repository.markSent(job.id, claimToken)).resolves.toBe(true);

      const sent = await reload(job.id);
      expect(sent.status).toBe(JobStatus.Sent);
      expect(sent.sentAt).toBeInstanceOf(Date);
      expect(sent.claimToken).toBeNull();
      expect(sent.lockedBy).toBeNull();
    });

    it('rejects a completion that presents the wrong claim token', async () => {
      const { job } = await repository.insertIfAbsent(newJob());
      await repository.claimDueJobs('worker-a', 1);

      await expect(
        repository.markSent(job.id, '00000000-0000-0000-0000-000000000000'),
      ).resolves.toBe(false);
      expect((await reload(job.id)).status).toBe(JobStatus.Processing);
    });

    it('never moves a terminal job again', async () => {
      const { job } = await repository.insertIfAbsent(newJob());
      const { claimToken } = await repository.claimDueJobs('worker-a', 1);
      await repository.markSent(job.id, claimToken);

      await expect(repository.markSent(job.id, claimToken)).resolves.toBe(false);
      await expect(repository.scheduleRetry(job.id, claimToken, 0, 'late')).resolves.toBe(false);
      expect((await reload(job.id)).status).toBe(JobStatus.Sent);
    });

    it('schedules a retry on the database clock and makes it claimable once due', async () => {
      const { job } = await repository.insertIfAbsent(newJob());
      const first = await repository.claimDueJobs('worker-a', 1);

      await repository.scheduleRetry(job.id, first.claimToken, 60_000, 'provider timeout');

      const pending = await reload(job.id);
      expect(pending.status).toBe(JobStatus.Pending);
      expect(pending.lastError).toBe('provider timeout');
      expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
      expect((await repository.claimDueJobs('worker-b', 1)).jobs).toHaveLength(0);

      await dataSource.query(`UPDATE notification_jobs SET next_attempt_at = now() WHERE id = $1`, [
        job.id,
      ]);
      const retry = await repository.claimDueJobs('worker-b', 1);
      expect(retry.jobs.map((j) => j.attemptCount)).toEqual([2]);
    });

    it('records permanent failures and dead letters with their error', async () => {
      const failed = await repository.insertIfAbsent(newJob());
      const dead = await repository.insertIfAbsent(newJob());
      const { claimToken } = await repository.claimDueJobs('worker-a', 2);

      await repository.markFailed(failed.job.id, claimToken, 'invalid recipient');
      await repository.markDeadLettered(dead.job.id, claimToken, 'still timing out');

      const f = await reload(failed.job.id);
      const d = await reload(dead.job.id);
      expect([f.status, f.lastError, f.failedAt]).toEqual([
        JobStatus.Failed,
        'invalid recipient',
        expect.any(Date),
      ]);
      expect([d.status, d.lastError, d.deadLetteredAt]).toEqual([
        JobStatus.DeadLettered,
        'still timing out',
        expect.any(Date),
      ]);
    });

    it('does not claim a job whose attempts are used up', async () => {
      await repository.insertIfAbsent(newJob({ maxAttempts: 1 }));
      const { jobs, claimToken } = await repository.claimDueJobs('worker-a', 1);
      await repository.scheduleRetry(jobs[0].id, claimToken, 0, 'boom');

      expect((await repository.claimDueJobs('worker-a', 1)).jobs).toHaveLength(0);
    });
  });

  describe('recoverStaleClaims', () => {
    it('requeues expired claims and leaves live ones alone', async () => {
      const stale = await repository.insertIfAbsent(newJob());
      const live = await repository.insertIfAbsent(newJob());
      await repository.claimDueJobs('worker-a', 2);
      await ageClaim(stale.job.id, 600);

      const outcome = await repository.recoverStaleClaims(300, 100);

      expect(outcome).toEqual({ requeued: [stale.job.id], deadLettered: [] });
      const requeued = await reload(stale.job.id);
      expect(requeued.status).toBe(JobStatus.Pending);
      expect(requeued.lockedBy).toBeNull();
      expect(requeued.lastError).toMatch(/Claim expired/);
      expect((await reload(live.job.id)).status).toBe(JobStatus.Processing);
    });

    it('fences out the original worker once its job is reclaimed', async () => {
      const { job } = await repository.insertIfAbsent(newJob());
      const slow = await repository.claimDueJobs('worker-slow', 1);
      await ageClaim(job.id, 600);
      await repository.recoverStaleClaims(300, 100);
      const fresh = await repository.claimDueJobs('worker-fresh', 1);

      await expect(repository.markSent(job.id, slow.claimToken)).resolves.toBe(false);
      await expect(repository.markSent(job.id, fresh.claimToken)).resolves.toBe(true);
      expect((await reload(job.id)).attemptCount).toBe(2);
    });

    it('dead-letters an expired claim that was the final attempt', async () => {
      const { job } = await repository.insertIfAbsent(newJob({ maxAttempts: 1 }));
      await repository.claimDueJobs('worker-a', 1);
      await ageClaim(job.id, 600);

      const outcome = await repository.recoverStaleClaims(300, 100);

      expect(outcome).toEqual({ requeued: [], deadLettered: [job.id] });
      expect((await reload(job.id)).deadLetteredAt).toBeInstanceOf(Date);
    });
  });
});
