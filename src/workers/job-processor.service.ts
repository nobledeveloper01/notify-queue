import { performance } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { DeliveryService } from '../delivery/delivery.service.js';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import { NotificationJobRepository } from '../notifications/repositories/notification-job.repository.js';
import { RetryService } from '../retry/retry.service.js';
import { JobClaimService } from './job-claim.service.js';

/**
 * Takes one claimed job through one delivery attempt and records the outcome.
 * Runs with no database transaction or lock held: the claim committed before
 * this starts, and each outcome is its own short, token-fenced UPDATE.
 */
@Injectable()
export class JobProcessorService {
  private readonly logger = new Logger(JobProcessorService.name);

  constructor(
    private readonly delivery: DeliveryService,
    private readonly retry: RetryService,
    private readonly jobs: NotificationJobRepository,
    private readonly claims: JobClaimService,
  ) {}

  /** Never rejects: an unexpected error leaves the job to lease-expiry recovery. */
  async process(job: NotificationJob, claimToken: string): Promise<void> {
    const started = performance.now();
    const context = { workerId: this.claims.workerId, jobId: job.id, attempt: job.attemptCount };

    try {
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
      this.logger.error({
        ...context,
        event: 'job.processing_error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started),
      });
    }
  }
}
