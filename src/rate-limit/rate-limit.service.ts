import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, RateLimitConfig } from '../config/configuration.js';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import { RecipientRateLimitRepository } from './repositories/recipient-rate-limit.repository.js';

export type Admission = { allowed: true } | { allowed: false; retryAt: Date };

/**
 * Sliding-window limit: a recipient receives at most RATE_LIMIT_MAX_NOTIFICATIONS
 * in any RATE_LIMIT_WINDOW_SECONDS. Unlike a fixed window, there is no
 * boundary where 2N can slip through (N at 12:59, N more at 13:00).
 *
 * The state lives in PostgreSQL because the workers are separate processes:
 * a counter in one worker's memory knows nothing of what the others sent.
 * What is counted is admission for delivery, which is conservative: an
 * attempt that then fails still used its slot.
 */
@Injectable()
export class RateLimitService {
  private readonly limit: RateLimitConfig;

  constructor(
    private readonly limits: RecipientRateLimitRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    this.limit = config.get('rateLimit', { infer: true });
  }

  admit(job: NotificationJob): Promise<Admission> {
    const { maxNotifications, windowSeconds } = this.limit;

    return this.limits.withRecipientLock(job.recipient, async (scope) => {
      // A retry or crash recovery of an admitted job keeps its original slot.
      if (await scope.hasActiveReservation(job.id, windowSeconds)) {
        return { allowed: true };
      }

      const { count, oldest } = await scope.recentUsage(job.recipient, windowSeconds);
      if (count >= maxNotifications && oldest) {
        return { allowed: false, retryAt: new Date(oldest.getTime() + windowSeconds * 1000) };
      }

      await scope.reserve(job.recipient, job.id);
      return { allowed: true };
    });
  }

  pruneExpired(): Promise<number> {
    return this.limits.pruneExpired(this.limit.windowSeconds);
  }
}
