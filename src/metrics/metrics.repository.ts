import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface RawQueueMetrics {
  jobsByStatus: Record<string, number>;
  /** Seconds the oldest due-but-unclaimed job has waited; 0 when none. */
  queueLagSeconds: number;
  webhooks: { pending: number; delivered: number; givenUp: number };
}

/**
 * Aggregates in SQL; never loads jobs into memory. Each figure is one index
 * or aggregate scan, cheap enough to scrape every few seconds.
 */
@Injectable()
export class MetricsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(): Promise<RawQueueMetrics> {
    const [byStatus, [lag], [webhooks]] = await Promise.all([
      this.dataSource.query<{ status: string; count: number }[]>(
        'SELECT status, count(*)::int AS count FROM notification_jobs GROUP BY status',
      ),
      this.dataSource.query<{ seconds: number }[]>(
        `SELECT coalesce(extract(epoch FROM now() - min(next_attempt_at)), 0)::float AS seconds
           FROM notification_jobs
          WHERE status = 'PENDING' AND next_attempt_at <= now()`,
      ),
      this.dataSource.query<{ pending: number; delivered: number; given_up: number }[]>(
        `SELECT count(*) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL)::int AS pending,
                count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
                count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS given_up
           FROM webhook_events`,
      ),
    ]);

    return {
      jobsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      queueLagSeconds: lag.seconds,
      webhooks: {
        pending: webhooks.pending,
        delivered: webhooks.delivered,
        givenUp: webhooks.given_up,
      },
    };
  }
}
