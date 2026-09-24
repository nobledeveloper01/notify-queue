import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runQuery } from '../../database/query.util.js';

/** Persistence for the demo receiver's record of event IDs it has seen. */
@Injectable()
export class MockWebhookReceiptRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Records a receipt and returns how many times this event ID has now arrived. */
  async record(eventId: string, jobId: string, status: string): Promise<number> {
    const {
      records: [row],
    } = await runQuery<{ received_count: number }>(
      this.dataSource,
      `INSERT INTO mock_webhook_receipts (event_id, job_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO UPDATE
         SET received_count = mock_webhook_receipts.received_count + 1,
             last_received_at = now()
       RETURNING received_count`,
      [eventId, jobId, status],
    );
    return row.received_count;
  }
}
