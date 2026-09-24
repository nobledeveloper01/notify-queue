import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import { JobClaimService } from './job-claim.service.js';
import { JobProcessorService } from './job-processor.service.js';

interface ClaimedJob {
  job: NotificationJob;
  claimToken: string;
}

export interface PollResult {
  /** How many jobs this poll asked for (0 when the worker is saturated or stopping). */
  requested: number;
  claimed: number;
}

export interface ShutdownReport {
  /** Claimed but never started; handed straight back to the queue. */
  released: number;
  /** Still delivering when the shutdown timeout ran out; lease expiry will recover them. */
  abandoned: number;
}

/**
 * Claims work and runs it with bounded concurrency.
 *
 * At most `WORKER_CONCURRENCY` deliveries run at once. Claimed jobs beyond
 * that wait in a local queue, and the worker never holds more than
 * `WORKER_BATCH_SIZE` claimed-but-unfinished jobs, so it cannot hoard work
 * (whose leases are ticking) that other workers could be doing.
 */
@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private readonly queue: ClaimedJob[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly concurrency: number;
  private readonly batchSize: number;
  private accepting = true;

  constructor(
    private readonly claims: JobClaimService,
    private readonly processor: JobProcessorService,
    config: ConfigService<AppConfig, true>,
  ) {
    const worker = config.get('worker', { infer: true });
    this.concurrency = worker.concurrency;
    this.batchSize = worker.batchSize;
  }

  /** Claimed jobs not yet finished: running plus waiting for a slot. */
  get inFlight(): number {
    return this.active.size + this.queue.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async poll(): Promise<PollResult> {
    const requested = this.accepting ? this.batchSize - this.inFlight : 0;
    if (requested <= 0) {
      return { requested: 0, claimed: 0 };
    }

    const { claimToken, jobs } = await this.claims.claim(requested);
    for (const job of jobs) {
      this.queue.push({ job, claimToken });
    }
    this.pump();
    return { requested, claimed: jobs.length };
  }

  /** Resolves once every claimed job has finished. */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.race(this.active);
    }
  }

  /**
   * Stops claiming, returns queued-but-unstarted jobs to the queue at once,
   * and gives running deliveries up to `timeoutMs` to finish.
   */
  async shutdown(timeoutMs: number): Promise<ShutdownReport> {
    this.accepting = false;

    const unstarted = this.queue.splice(0);
    const releases = await Promise.all(
      unstarted.map(({ job, claimToken }) => this.claims.release(job.id, claimToken)),
    );

    const abort = new AbortController();
    const drained = await Promise.race([
      this.whenIdle().then(() => true),
      sleep(timeoutMs, false, { signal: abort.signal }).catch(() => false),
    ]);
    abort.abort();

    const report = {
      released: releases.filter(Boolean).length,
      abandoned: drained ? 0 : this.active.size,
    };
    this.logger.log({ workerId: this.claims.workerId, event: 'worker.drained', ...report });
    return report;
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const next = this.queue.shift();
      if (!next) return;

      const run: Promise<void> = this.processor.process(next.job, next.claimToken).finally(() => {
        this.active.delete(run);
        this.pump();
      });
      this.active.add(run);
    }
  }
}
