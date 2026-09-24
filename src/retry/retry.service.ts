import { Injectable } from '@nestjs/common';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import { NotificationJobRepository } from '../notifications/repositories/notification-job.repository.js';
import { RetryPolicyService } from './retry-policy.service.js';
import type { RetryDecision } from './retry-policy.service.js';

export interface FailureOutcome {
  decision: RetryDecision;
  /** False if the claim was lost before the outcome could be written. */
  recorded: boolean;
}

/** Applies the retry policy to a failed attempt and records the result. */
@Injectable()
export class RetryService {
  constructor(
    private readonly policy: RetryPolicyService,
    private readonly jobs: NotificationJobRepository,
  ) {}

  async handleFailure(
    job: NotificationJob,
    claimToken: string,
    failure: { retryable: boolean; error: string },
  ): Promise<FailureOutcome> {
    // attemptCount was incremented when this attempt was claimed.
    const decision = this.policy.decide(job.attemptCount, job.maxAttempts, failure.retryable);

    const recorded = await (() => {
      switch (decision.action) {
        case 'fail':
          return this.jobs.markFailed(job.id, claimToken, failure.error);
        case 'dead_letter':
          return this.jobs.markDeadLettered(job.id, claimToken, failure.error);
        case 'retry':
          return this.jobs.scheduleRetry(job.id, claimToken, decision.delayMs, failure.error);
      }
    })();

    return { decision, recorded };
  }
}
