import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { RANDOM } from '../common/tokens/random.token.js';
import type { RandomSource } from '../common/tokens/random.token.js';

export type RetryDecision =
  { action: 'retry'; delayMs: number } | { action: 'dead_letter' } | { action: 'fail' };

/**
 * Pure policy: given a failed attempt, what happens next. No I/O.
 *
 * Backoff is exponential, `min(base * 2^(attempt-1), max)`, so a struggling
 * provider sees retries thin out instead of a storm. Jitter then spreads each
 * delay over [half, full]: jobs that failed together (one provider outage)
 * do not all come back in the same instant.
 */
@Injectable()
export class RetryPolicyService {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Inject(RANDOM) private readonly random: RandomSource,
  ) {
    const retry = config.get('retry', { infer: true });
    this.baseDelayMs = retry.baseDelayMs;
    this.maxDelayMs = retry.maxDelayMs;
  }

  /** Delay before the next attempt, after attempt number `attempt` (1-based) failed. */
  delayAfterAttempt(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    return Math.round(exponential / 2 + this.random() * (exponential / 2));
  }

  decide(attempt: number, maxAttempts: number, retryable: boolean): RetryDecision {
    if (!retryable) {
      return { action: 'fail' };
    }
    if (attempt >= maxAttempts) {
      return { action: 'dead_letter' };
    }
    return { action: 'retry', delayMs: this.delayAfterAttempt(attempt) };
  }
}
