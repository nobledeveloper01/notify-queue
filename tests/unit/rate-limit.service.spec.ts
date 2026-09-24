import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../src/config/configuration.js';
import type { NotificationJob } from '../../src/notifications/entities/notification-job.entity.js';
import { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';
import type {
  RecipientLockScope,
  RecipientRateLimitRepository,
} from '../../src/rate-limit/repositories/recipient-rate-limit.repository.js';

/** In-memory stand-in for the repository, with a clock the test controls. */
class FakeLimits {
  now = new Date('2026-09-24T12:00:00Z').getTime();
  readonly reservations = new Map<string, { recipient: string; at: number }>();

  withRecipientLock<T>(_recipient: string, work: (scope: RecipientLockScope) => Promise<T>) {
    const inWindow = (at: number, windowSeconds: number) => at > this.now - windowSeconds * 1000;
    return work({
      hasActiveReservation: (jobId, windowSeconds) => {
        const r = this.reservations.get(jobId);
        return Promise.resolve(r !== undefined && inWindow(r.at, windowSeconds));
      },
      recentUsage: (recipient, windowSeconds) => {
        const times = [...this.reservations.values()]
          .filter((r) => r.recipient === recipient && inWindow(r.at, windowSeconds))
          .map((r) => r.at);
        return Promise.resolve({
          count: times.length,
          oldest: times.length ? new Date(Math.min(...times)) : null,
        });
      },
      reserve: (recipient, jobId) => {
        this.reservations.set(jobId, { recipient, at: this.now });
        return Promise.resolve();
      },
    });
  }

  advance(seconds: number): void {
    this.now += seconds * 1000;
  }
}

const job = (id: string, recipient = 'user@example.com') => ({ id, recipient }) as NotificationJob;

describe('RateLimitService', () => {
  let limits: FakeLimits;
  let service: RateLimitService;

  beforeEach(() => {
    limits = new FakeLimits();
    const config = {
      get: () => ({ maxNotifications: 3, windowSeconds: 60 }),
    } as unknown as ConfigService<AppConfig, true>;
    service = new RateLimitService(limits as unknown as RecipientRateLimitRepository, config);
  });

  it('admits up to the limit, then refuses until the oldest send leaves the window', async () => {
    await service.admit(job('a'));
    limits.advance(10);
    await service.admit(job('b'));
    await service.admit(job('c'));

    const refused = await service.admit(job('d'));

    expect(refused).toEqual({
      allowed: false,
      retryAt: new Date('2026-09-24T12:01:00Z'),
    });
  });

  it('slides: a slot frees exactly when the oldest reservation ages out', async () => {
    await service.admit(job('a'));
    limits.advance(10);
    await service.admit(job('b'));
    await service.admit(job('c'));
    limits.advance(49);
    expect((await service.admit(job('d'))).allowed).toBe(false);

    limits.advance(1); // 60s after 'a': only 'a' has left the window

    expect(await service.admit(job('d'))).toEqual({ allowed: true });
    expect((await service.admit(job('e'))).allowed).toBe(false);
  });

  it('never allows more than the limit in any window, unlike a fixed window', async () => {
    // Fixed windows would allow 3 at 12:00:59 and 3 more at 12:01:00.
    limits.advance(59);
    for (const id of ['a', 'b', 'c']) await service.admit(job(id));
    limits.advance(1);

    expect((await service.admit(job('d'))).allowed).toBe(false);
  });

  it('keeps the original slot for a retried or recovered job', async () => {
    for (const id of ['a', 'b', 'c']) await service.admit(job(id));

    expect(await service.admit(job('b'))).toEqual({ allowed: true });
    expect(limits.reservations.size).toBe(3);
  });

  it('limits each recipient independently', async () => {
    for (const id of ['a', 'b', 'c']) await service.admit(job(id, 'one@example.com'));

    expect(await service.admit(job('d', 'two@example.com'))).toEqual({ allowed: true });
  });
});
