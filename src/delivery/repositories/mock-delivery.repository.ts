import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { NotificationChannel } from '../../common/enums/notification-channel.enum.js';

export interface RecordedDelivery {
  messageId: string;
  /** False when the delivery key had already been recorded. */
  created: boolean;
}

/** Persistence for the mock provider's own idempotency record (see the migration). */
@Injectable()
export class MockDeliveryRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findMessageId(deliveryKey: string): Promise<string | null> {
    const rows: { message_id: string }[] = await this.dataSource.query(
      'SELECT message_id FROM mock_provider_deliveries WHERE delivery_key = $1',
      [deliveryKey],
    );
    return rows.at(0)?.message_id ?? null;
  }

  /** Records the delivery once; a concurrent or repeated call gets the original message ID. */
  async record(
    deliveryKey: string,
    recipient: string,
    channel: NotificationChannel,
  ): Promise<RecordedDelivery> {
    const inserted: { message_id: string }[] = await this.dataSource.query(
      `INSERT INTO mock_provider_deliveries (delivery_key, recipient, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (delivery_key) DO NOTHING
       RETURNING message_id`,
      [deliveryKey, recipient, channel],
    );
    const created = inserted.at(0);
    if (created) {
      return { messageId: created.message_id, created: true };
    }
    const existing = await this.findMessageId(deliveryKey);
    if (!existing) {
      throw new Error(`Mock delivery ${deliveryKey} vanished after insert`);
    }
    return { messageId: existing, created: false };
  }
}
