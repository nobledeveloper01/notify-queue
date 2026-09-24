import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../src/config/configuration.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';
import { RecipientRateLimitRepository } from '../../src/rate-limit/repositories/recipient-rate-limit.repository.js';
import { WorkerService } from '../../src/workers/worker.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import { RecordingProvider } from '../support/test-providers.js';
import { countByStatus } from '../support/worker-helpers.js';

const RECIPIENT = 'popular@example.com';

describe('rate limit under concurrent workers (PostgreSQL)', () => {
  let admin: DataSource;
  let jobs: NotificationJobRepository;

  beforeAll(async () => {
    admin = await createTestDataSource();
    jobs = new NotificationJobRepository(admin);
  });

  afterAll(async () => {
    await admin.destroy();
  });

  beforeEach(async () => {
    await truncateAll(admin);
  });

  /**
   * The race the spec describes: limit N, and many workers each see N-1 used
   * at the same moment. Twenty admissions for one recipient, each from its
   * own connection pool, all released at once.
   */
  it('admits exactly N of 20 simultaneous admissions for one recipient', async () => {
    const limit = 3;
    const pools = await Promise.all(Array.from({ length: 20 }, () => createTestDataSource(1)));
    try {
      const inserted = await Promise.all(
        pools.map(() => jobs.insertIfAbsent(newJob({ recipient: RECIPIENT }))),
      );
      const config = {
        get: () => ({ maxNotifications: limit, windowSeconds: 3600 }),
      } as unknown as ConfigService<AppConfig, true>;

      const admissions = await Promise.all(
        pools.map((ds, i) =>
          new RateLimitService(new RecipientRateLimitRepository(ds), config).admit(inserted[i].job),
        ),
      );

      expect(admissions.filter((a) => a.allowed)).toHaveLength(limit);
      const [{ count }]: { count: string }[] = await admin.query(
        'SELECT count(*) FROM rate_limit_reservations WHERE recipient = $1',
        [RECIPIENT],
      );
      expect(count).toBe(String(limit));
    } finally {
      await Promise.all(pools.map((ds) => ds.destroy()));
    }
  });

  describe('with 10 worker applications', () => {
    let apps: INestApplication[];
    let workers: WorkerService[];
    let provider: RecordingProvider;

    const startWorkers = async (env: Record<string, string>) => {
      provider = new RecordingProvider(5);
      apps = [];
      for (let i = 0; i < 10; i++) {
        apps.push(
          await createTestApp({
            provider,
            listen: false,
            env: { WORKER_ID: `rl-worker-${i}`, DATABASE_POOL_MAX: '3', ...env },
          }),
        );
      }
      workers = apps.map((a) => a.get(WorkerService));
    };

    const pollAll = async () => {
      await Promise.all(workers.map((w) => w.poll()));
      await Promise.all(workers.map((w) => w.whenIdle()));
    };

    afterEach(async () => {
      await Promise.all(apps.map((a) => a.close()));
    });

    it('sends exactly the limit to one recipient however many workers compete', async () => {
      await startWorkers({ RATE_LIMIT_MAX_NOTIFICATIONS: '5', RATE_LIMIT_WINDOW_SECONDS: '3600' });
      await Promise.all(
        Array.from({ length: 40 }, () => jobs.insertIfAbsent(newJob({ recipient: RECIPIENT }))),
      );

      await pollAll();
      await pollAll();

      expect(provider.calls).toHaveLength(5);
      expect(await countByStatus(admin)).toEqual({ SENT: 5, PENDING: 35 });
      const [{ max }]: { max: number }[] = await admin.query(
        `SELECT max(attempt_count) FROM notification_jobs WHERE status = 'PENDING'`,
      );
      expect(max).toBe(0);
    });

    it('never exceeds the limit in any sliding window while workers keep draining', async () => {
      const limit = 3;
      await startWorkers({
        RATE_LIMIT_MAX_NOTIFICATIONS: String(limit),
        RATE_LIMIT_WINDOW_SECONDS: '1',
      });
      await Promise.all(
        Array.from({ length: 15 }, () => jobs.insertIfAbsent(newJob({ recipient: RECIPIENT }))),
      );

      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        await pollAll();
        await sleep(20);
      }

      // For every admission, count admissions in the one-second window it opens.
      const [{ worst }]: { worst: number }[] = await admin.query(
        `SELECT max(n)::int AS worst FROM (
           SELECT (SELECT count(*) FROM rate_limit_reservations b
                    WHERE b.recipient = a.recipient
                      AND b.reserved_at >= a.reserved_at
                      AND b.reserved_at < a.reserved_at + interval '1 second') AS n
             FROM rate_limit_reservations a WHERE a.recipient = $1) windows`,
        [RECIPIENT],
      );
      const sent = (await countByStatus(admin)).SENT ?? 0;

      expect(worst).toBeLessThanOrEqual(limit);
      // Progress, not starvation: roughly `limit` per second over ~3.5s.
      expect(sent).toBeGreaterThanOrEqual(3 * limit);
      expect(provider.calls).toHaveLength(sent);
    });
  });
});
