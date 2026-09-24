import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { NotificationJobRepository } from '../notifications/repositories/notification-job.repository.js';
import type { RecoveryOutcome } from '../notifications/repositories/notification-job.repository.js';

const RECOVERY_BATCH = 500;

/**
 * Finds jobs whose worker vanished mid-delivery (claim older than the
 * visibility timeout) and puts them back in the queue. Every worker runs it;
 * SKIP LOCKED lets several run at once without contending for the same rows.
 *
 * The trade-off lives in JOB_VISIBILITY_TIMEOUT_SECONDS: shorter recovers
 * crashed work sooner, but must stay well above the longest legitimate
 * delivery (PROVIDER_TIMEOUT_MS enforces that), or live jobs get reclaimed.
 */
@Injectable()
export class WorkerRecoveryService {
  private readonly logger = new Logger(WorkerRecoveryService.name);
  private readonly visibilityTimeoutSeconds: number;
  private readonly workerId: string;
  private running = false;

  constructor(
    private readonly jobs: NotificationJobRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    const worker = config.get('worker', { infer: true });
    this.visibilityTimeoutSeconds = worker.visibilityTimeoutSeconds;
    this.workerId = worker.id;
  }

  async recoverStale(): Promise<RecoveryOutcome> {
    if (this.running) {
      return { requeued: [], deadLettered: [] };
    }
    this.running = true;
    try {
      const outcome = await this.jobs.recoverStaleClaims(
        this.visibilityTimeoutSeconds,
        RECOVERY_BATCH,
      );
      if (outcome.requeued.length > 0 || outcome.deadLettered.length > 0) {
        this.logger.warn({
          workerId: this.workerId,
          event: 'jobs.recovered',
          requeued: outcome.requeued.length,
          deadLettered: outcome.deadLettered.length,
        });
      }
      return outcome;
    } finally {
      this.running = false;
    }
  }
}
