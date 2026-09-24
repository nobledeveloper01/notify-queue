import { Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { AppConfig, WorkerConfig } from '../config/configuration.js';
import { AppRole } from '../config/env.validation.js';
import { errorMessage } from '../common/utils/error.util.js';
import { WebhookService } from '../webhooks/webhook.service.js';
import { WorkerRecoveryService } from './worker-recovery.service.js';
import { WorkerService } from './worker.service.js';

const POLL_TIMEOUT = 'worker-poll';
const RECOVERY_INTERVAL = 'worker-recovery';
const WEBHOOK_INTERVAL = 'webhook-dispatch';

/**
 * Drives the worker loop; holds no job logic itself.
 *
 * Polling is a self-rescheduling timeout, not a fixed interval: the next poll
 * is scheduled only after the previous one finishes, so polls never overlap.
 * A poll that filled its whole request suggests a backlog, so the next one
 * runs immediately; otherwise the worker waits WORKER_POLL_INTERVAL_MS.
 * Idle workers therefore cost one cheap indexed query per interval.
 */
@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkerScheduler.name);
  private readonly config: WorkerConfig;
  private readonly webhookPollIntervalMs: number;
  private readonly enabled: boolean;
  private running = false;
  private currentTick: Promise<void> = Promise.resolve();
  /** Recovery and webhook runs in flight; shutdown waits for them before the pool closes. */
  private readonly background = new Set<Promise<void>>();

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly worker: WorkerService,
    private readonly recovery: WorkerRecoveryService,
    private readonly webhooks: WebhookService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.config = config.get('worker', { infer: true });
    this.webhookPollIntervalMs = config.get('webhook', { infer: true }).pollIntervalMs;
    this.enabled = config.get('role', { infer: true }) !== AppRole.Api;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log({ event: 'worker.disabled', reason: 'APP_ROLE=api' });
      return;
    }
    this.running = true;
    this.logger.log({
      event: 'worker.started',
      workerId: this.config.id,
      concurrency: this.config.concurrency,
      batchSize: this.config.batchSize,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    this.registry.addInterval(
      RECOVERY_INTERVAL,
      setInterval(() => {
        this.track(this.recoverSafely());
      }, this.config.recoveryIntervalMs),
    );
    this.track(this.recoverSafely());
    if (this.webhooks.enabled) {
      this.registry.addInterval(
        WEBHOOK_INTERVAL,
        setInterval(() => {
          this.track(this.dispatchWebhooksSafely());
        }, this.webhookPollIntervalMs),
      );
    }
    this.scheduleNextPoll(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.registry.doesExist('timeout', POLL_TIMEOUT)) this.registry.deleteTimeout(POLL_TIMEOUT);
    for (const name of [RECOVERY_INTERVAL, WEBHOOK_INTERVAL]) {
      if (this.registry.doesExist('interval', name)) this.registry.deleteInterval(name);
    }

    await this.currentTick;
    await Promise.allSettled([...this.background]);
    await this.worker.shutdown(this.config.shutdownTimeoutMs);
  }

  private track(run: Promise<void>): void {
    this.background.add(run);
    void run.finally(() => this.background.delete(run));
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return;
    this.registry.addTimeout(
      POLL_TIMEOUT,
      setTimeout(() => {
        this.registry.deleteTimeout(POLL_TIMEOUT);
        this.currentTick = this.tick();
      }, delayMs),
    );
  }

  private async tick(): Promise<void> {
    let nextDelay = this.config.pollIntervalMs;
    try {
      const { requested, claimed } = await this.worker.poll();
      if (claimed > 0 && claimed === requested) {
        nextDelay = 0;
      }
    } catch (error: unknown) {
      // Database unreachable, most likely. Keep the loop alive and try again.
      this.logger.error({
        event: 'worker.poll_failed',
        workerId: this.config.id,
        error: errorMessage(error),
      });
    }
    this.scheduleNextPoll(nextDelay);
  }

  private async dispatchWebhooksSafely(): Promise<void> {
    try {
      await this.webhooks.dispatchDue();
    } catch (error: unknown) {
      this.logger.error({
        event: 'webhook.dispatch_failed',
        workerId: this.config.id,
        error: errorMessage(error),
      });
    }
  }

  private async recoverSafely(): Promise<void> {
    try {
      await this.recovery.recoverStale();
    } catch (error: unknown) {
      this.logger.error({
        event: 'worker.recovery_failed',
        workerId: this.config.id,
        error: errorMessage(error),
      });
    }
  }
}
