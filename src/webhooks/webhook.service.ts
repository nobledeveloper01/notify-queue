import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  WEBHOOK_BATCH_SIZE,
  WEBHOOK_EVENT_ID_HEADER,
} from '../common/constants/webhook.constants.js';
import type { AppConfig, WebhookConfig } from '../config/configuration.js';
import { RetryPolicyService } from '../retry/retry-policy.service.js';
import type { WebhookEventDto } from './dto/webhook-event.dto.js';
import { WebhookEventRepository } from './repositories/webhook-event.repository.js';
import type { ClaimedWebhookEvent } from './repositories/webhook-event.repository.js';

export interface DispatchReport {
  delivered: number;
  retrying: number;
  givenUp: number;
}

/**
 * Delivers outbox events to WEBHOOK_URL.
 *
 * At-least-once, not exactly-once: a dispatcher can POST successfully and die
 * before recording it, and the event goes out again after its lease expires.
 * Receivers must dedupe on `eventId` (sent in the body and the
 * X-Webhook-Event-Id header). Nothing here ever touches the job itself, so a
 * failing webhook cannot change a notification's status.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly config: WebhookConfig;
  private running = false;

  constructor(
    private readonly http: HttpService,
    private readonly events: WebhookEventRepository,
    private readonly retryPolicy: RetryPolicyService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.config = config.get('webhook', { infer: true });
  }

  get enabled(): boolean {
    return this.config.url !== undefined;
  }

  async dispatchDue(): Promise<DispatchReport> {
    const report: DispatchReport = { delivered: 0, retrying: 0, givenUp: 0 };
    if (!this.config.url || this.running) {
      return report;
    }
    this.running = true;
    try {
      const leaseSeconds = Math.ceil((this.config.timeoutMs * 2) / 1000);
      const claimed = await this.events.claimDue(WEBHOOK_BATCH_SIZE, leaseSeconds);
      const outcomes = await Promise.all(claimed.map((event) => this.dispatch(event)));
      for (const outcome of outcomes) report[outcome]++;
      return report;
    } finally {
      this.running = false;
    }
  }

  private async dispatch(event: ClaimedWebhookEvent): Promise<keyof DispatchReport> {
    const body: WebhookEventDto = {
      eventId: event.id,
      jobId: event.jobId,
      status: event.status,
      attemptCount: event.attemptCount,
      timestamp: event.occurredAt.toISOString(),
    };

    try {
      await firstValueFrom(
        this.http.post(this.config.url as string, body, {
          timeout: this.config.timeoutMs,
          headers: { [WEBHOOK_EVENT_ID_HEADER]: event.id },
        }),
      );
      await this.events.markDelivered(event.id);
      return 'delivered';
    } catch (error: unknown) {
      const reason = describeError(error);
      const context = {
        event: 'webhook.failed',
        eventId: event.id,
        jobId: event.jobId,
        dispatchAttempt: event.dispatchAttempts,
        error: reason,
      };

      if (event.dispatchAttempts >= this.config.maxAttempts) {
        await this.events.markGivenUp(event.id, reason);
        this.logger.error({ ...context, gaveUp: true });
        return 'givenUp';
      }
      const delayMs = this.retryPolicy.delayAfterAttempt(event.dispatchAttempts);
      await this.events.scheduleRetry(event.id, delayMs, reason);
      this.logger.warn({ ...context, retryInMs: delayMs });
      return 'retrying';
    }
  }
}

const describeError = (error: unknown): string => {
  if (isAxiosError(error)) {
    return error.response ? `HTTP ${error.response.status}` : (error.code ?? error.message);
  }
  return error instanceof Error ? error.message : 'Unknown error';
};
