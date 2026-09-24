import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../src/config/configuration.js';
import type { NotificationJob } from '../../src/notifications/entities/notification-job.entity.js';
import type { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { RetryPolicyService } from '../../src/retry/retry-policy.service.js';
import { RetryService } from '../../src/retry/retry.service.js';

const config = (baseDelayMs = 1000, maxDelayMs = 60_000) =>
  ({
    get: () => ({ maxRetries: 5, baseDelayMs, maxDelayMs }),
  }) as unknown as ConfigService<AppConfig, true>;

describe('RetryPolicyService', () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [7, 60_000],
    [30, 60_000],
  ])('caps the exponential delay after attempt %i at %i ms', (attempt, ceiling) => {
    const highest = new RetryPolicyService(config(), () => 0.999_999);
    const lowest = new RetryPolicyService(config(), () => 0);

    expect(highest.delayAfterAttempt(attempt)).toBe(ceiling);
    expect(lowest.delayAfterAttempt(attempt)).toBe(ceiling / 2);
  });

  it('spreads jobs that failed together across the jitter window', () => {
    let seed = 0;
    const policy = new RetryPolicyService(config(), () => (seed++ % 10) / 10);

    const delays = new Set(Array.from({ length: 10 }, () => policy.delayAfterAttempt(3)));

    expect(delays.size).toBe(10);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it('retries a retryable failure while attempts remain', () => {
    const policy = new RetryPolicyService(config(), () => 0);

    expect(policy.decide(1, 6, true)).toEqual({ action: 'retry', delayMs: 500 });
    expect(policy.decide(5, 6, true)).toEqual({ action: 'retry', delayMs: 8000 });
  });

  it('dead-letters once the final attempt fails', () => {
    const policy = new RetryPolicyService(config(), () => 0);

    expect(policy.decide(6, 6, true)).toEqual({ action: 'dead_letter' });
  });

  it('fails a permanent error immediately, whatever attempts remain', () => {
    const policy = new RetryPolicyService(config(), () => 0);

    expect(policy.decide(1, 6, false)).toEqual({ action: 'fail' });
  });
});

describe('RetryService', () => {
  const jobAt = (attemptCount: number) =>
    ({ id: 'job-1', attemptCount, maxAttempts: 3 }) as NotificationJob;
  const job = jobAt(2);
  let jobs: {
    scheduleRetry: jest.Mock<NotificationJobRepository['scheduleRetry']>;
    markDeadLettered: jest.Mock<NotificationJobRepository['markDeadLettered']>;
    markFailed: jest.Mock<NotificationJobRepository['markFailed']>;
  };
  let service: RetryService;

  beforeEach(() => {
    jobs = {
      scheduleRetry: jest.fn(() => Promise.resolve(true)),
      markDeadLettered: jest.fn(() => Promise.resolve(true)),
      markFailed: jest.fn(() => Promise.resolve(true)),
    };
    service = new RetryService(
      new RetryPolicyService(config(), () => 0),
      jobs as unknown as NotificationJobRepository,
    );
  });

  it('records a retry with the policy delay and the error', async () => {
    const outcome = await service.handleFailure(job, 'token', { retryable: true, error: 'boom' });

    expect(outcome).toEqual({ decision: { action: 'retry', delayMs: 1000 }, recorded: true });
    expect(jobs.scheduleRetry).toHaveBeenCalledWith('job-1', 'token', 1000, 'boom');
  });

  it('dead-letters on the last attempt', async () => {
    await service.handleFailure(jobAt(3), 'token', {
      retryable: true,
      error: 'boom',
    });

    expect(jobs.markDeadLettered).toHaveBeenCalledWith('job-1', 'token', 'boom');
    expect(jobs.scheduleRetry).not.toHaveBeenCalled();
  });

  it('marks a permanent failure FAILED', async () => {
    await service.handleFailure(job, 'token', { retryable: false, error: 'rejected' });

    expect(jobs.markFailed).toHaveBeenCalledWith('job-1', 'token', 'rejected');
  });

  it('reports when the claim was lost before the outcome was written', async () => {
    jobs.scheduleRetry.mockResolvedValueOnce(false);

    const outcome = await service.handleFailure(job, 'stale', { retryable: true, error: 'boom' });

    expect(outcome.recorded).toBe(false);
  });
});
