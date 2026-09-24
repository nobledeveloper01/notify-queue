import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backing store for MockNotificationProvider, which stands in for an external
 * provider (SES, Twilio, FCM). Real providers keep their own record of the
 * idempotency keys they have accepted; this table is that record for the
 * mock. It is shared by all workers, just as the real provider's is, which is
 * what lets a job recovered by a *different* worker be recognised as already
 * delivered. It is not part of the queue: production would not have it.
 */
export class CreateMockProviderDeliveries1790380800000 implements MigrationInterface {
  name = 'CreateMockProviderDeliveries1790380800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mock_provider_deliveries (
        delivery_key  varchar(255) NOT NULL,
        message_id    uuid         NOT NULL DEFAULT gen_random_uuid(),
        recipient     varchar(320) NOT NULL,
        channel       varchar(16)  NOT NULL,
        delivered_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT pk_mock_provider_deliveries PRIMARY KEY (delivery_key)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE mock_provider_deliveries');
  }
}
