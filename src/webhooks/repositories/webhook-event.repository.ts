import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runQuery } from '../../database/query.util.js';
import type { WebhookStatus } from '../dto/webhook-event.dto.js';

export interface ClaimedWebhookEvent {
  id: string;
  jobId: string;
  status: WebhookStatus;
  attemptCount: number;
  occurredAt: Date;
  /** Including the one this claim is about to make. */
  dispatchAttempts: number;
}

interface WebhookEventRow {
  id: string;
  job_id: string;
  status: WebhookStatus;
  attempt_count: number;
  occurred_at: Date;
  dispatch_attempts: number;
}

/** Persistence for the webhook outbox (see the migration for the design). */
@Injectable()
export class WebhookEventRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Claims due events in one statement: rows locked by another dispatcher are
   * skipped, and each claimed row's `next_attempt_at` is pushed out by the
   * lease, so a dispatcher that dies mid-POST releases it by simply expiring.
   */
  async claimDue(limit: number, leaseSeconds: number): Promise<ClaimedWebhookEvent[]> {
    const { records: rows } = await runQuery<WebhookEventRow>(
      this.dataSource,
      `UPDATE webhook_events
          SET dispatch_attempts = dispatch_attempts + 1,
              next_attempt_at = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM webhook_events
           WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, job_id, status, attempt_count, occurred_at, dispatch_attempts`,
      [limit, leaseSeconds],
    );
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      status: r.status,
      attemptCount: r.attempt_count,
      occurredAt: r.occurred_at,
      dispatchAttempts: r.dispatch_attempts,
    }));
  }

  async markDelivered(id: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE webhook_events SET delivered_at = now(), last_error = NULL
        WHERE id = $1 AND delivered_at IS NULL`,
      [id],
    );
  }

  /**
   * The failure updates are fenced on the dispatch attempt that produced
   * them: if this dispatcher's lease ran out and another dispatcher has
   * already claimed the event again, a late failure report changes nothing.
   */
  async scheduleRetry(
    id: string,
    dispatchAttempt: number,
    delayMs: number,
    error: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE webhook_events
          SET next_attempt_at = now() + make_interval(secs => $3), last_error = $4
        WHERE id = $1 AND dispatch_attempts = $2 AND delivered_at IS NULL`,
      [id, dispatchAttempt, delayMs / 1000, error],
    );
  }

  async markGivenUp(id: string, dispatchAttempt: number, error: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE webhook_events SET failed_at = now(), last_error = $3
        WHERE id = $1 AND dispatch_attempts = $2 AND delivered_at IS NULL`,
      [id, dispatchAttempt, error],
    );
  }
}
