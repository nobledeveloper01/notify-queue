import { performance } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { loggableError } from '../common/utils/error.util.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import { NotificationJobRepository } from '../notifications/repositories/notification-job.repository.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { RetryService } from '../retry/retry.service.js';
import { JobClaimService } from './job-claim.service.js';

/**
 * Takes one claimed job through one delivery attempt and records the outcome.
 * Runs with no database transaction or lock held: the claim committed before
 * this starts, and each outcome is its own short, token-fenced UPDATE.
 *
 * A recipient over its rate limit is not an attempt: the job goes back to the
 * queue, due when a slot frees, with its attempt refunded.
 */
@Injectable()
export class JobProcessorService {
  private readonly logger = new Logger(JobProcessorService.name);

  constructor(
    private readonly delivery: DeliveryService,
    private readonly rateLimit: RateLimitService,
    private readonly retry: RetryService,
    private readonly jobs: NotificationJobRepository,
    private readonly claims: JobClaimService,
  ) {}

  /**
   * Never rejects. If something fails before the provider is called, the
   * attempt is handed back (refunded, due now). If it fails after, the
   * provider may have delivered, so the job is left to lease-expiry recovery,
   * which resends with the same delivery key.
   */
  async process(job: NotificationJob, claimToken: string): Promise<void> {
    const started = performance.now();
    const context = { workerId: this.claims.workerId, jobId: job.id, attempt: job.attemptCount };
    let providerCalled = false;

    try {
      if (!(await this.claims.start(job.id, claimToken))) {
        // Reclaimed while waiting in this worker's queue: someone else owns it.
        this.logger.warn({ ...context, event: 'job.claim_lost', stage: 'start' });
        return;
      }

      const admission = await this.rateLimit.admit(job);
      if (!admission.allowed) {
        const recorded = await this.jobs.deferRateLimited(job.id, claimToken, admission.retryAt);
        this.logger.log({
          ...context,
          event: recorded ? 'job.rate_limited' : 'job.claim_lost',
          retryAt: admission.retryAt.toISOString(),
        });
        return;
      }

      providerCalled = true;
      const result = await this.delivery.deliver(job);
      const durationMs = Math.round(performance.now() - started);

      if (result.outcome === 'delivered') {
        const recorded = await this.jobs.markSent(job.id, claimToken);
        this.logger.log({
          ...context,
          event: recorded ? 'job.sent' : 'job.claim_lost',
          duplicate: result.duplicate,
          durationMs,
        });
        return;
      }

      const { decision, recorded } = await this.retry.handleFailure(job, claimToken, result);
      this.logger.warn({
        ...context,
        event: recorded ? `job.${decision.action}` : 'job.claim_lost',
        error: result.error,
        ...(decision.action === 'retry' ? { retryInMs: decision.delayMs } : {}),
        durationMs,
      });
    } catch (error: unknown) {
      const { stack, ...details } = loggableError(error);
      this.logger.error(
        {
          ...context,
          event: 'job.processing_error',
          providerCalled,
          error: details,
          durationMs: Math.round(performance.now() - started),
        },
        stack,
      );
      if (!providerCalled) {
        await this.handBack(job, claimToken, context);
      }
    }
  }

  /** Nothing reached the provider: return the job now instead of waiting out the lease. */
  private async handBack(
    job: NotificationJob,
    claimToken: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const released = await this.claims.release(job.id, claimToken);
      this.logger.warn({ ...context, event: released ? 'job.released' : 'job.claim_lost' });
    } catch {
      // The database is likely unreachable; lease expiry will recover the job.
    }
  }
}
