import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { NotificationJobRepository } from '../notifications/repositories/notification-job.repository.js';
import type { ClaimedBatch } from '../notifications/repositories/notification-job.repository.js';

/** Claims and releases work on behalf of this worker process, under its worker ID. */
@Injectable()
export class JobClaimService {
  readonly workerId: string;

  constructor(
    private readonly jobs: NotificationJobRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    this.workerId = config.get('worker', { infer: true }).id;
  }

  claim(batchSize: number): Promise<ClaimedBatch> {
    return this.jobs.claimDueJobs(this.workerId, batchSize);
  }

  start(jobId: string, claimToken: string): Promise<boolean> {
    return this.jobs.startAttempt(jobId, claimToken);
  }

  release(jobId: string, claimToken: string): Promise<boolean> {
    return this.jobs.releaseClaim(jobId, claimToken);
  }
}
