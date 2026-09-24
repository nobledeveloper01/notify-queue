import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transactional outbox for status-change webhooks.
 *
 * A row is written in the same transaction that moves a job to SENT, FAILED
 * or DEAD_LETTERED, so an event exists if and only if the status changed:
 * no crash can lose one. Dispatchers claim due rows with SKIP LOCKED, POST
 * them, and retry with backoff, which makes delivery at-least-once; the
 * event ID lets receivers drop duplicates.
 *
 * `mock_webhook_receipts` is the other side: the store behind the demo
 * receiver (POST /webhooks/mock), showing how a receiver dedupes by event ID.
 */
export class CreateWebhookOutbox1790553600000 implements MigrationInterface {
  name = 'CreateWebhookOutbox1790553600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE webhook_events (
        id               uuid         NOT NULL DEFAULT gen_random_uuid(),
        job_id           uuid         NOT NULL,
        status           varchar(16)  NOT NULL,
        attempt_count    integer      NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        dispatch_attempts integer     NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
        last_error       text,
        delivered_at     timestamptz,
        failed_at        timestamptz,
        created_at       timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT pk_webhook_events PRIMARY KEY (id),
        CONSTRAINT fk_webhook_events_job
          FOREIGN KEY (job_id) REFERENCES notification_jobs (id) ON DELETE CASCADE,
        -- Terminal statuses are reached once, so one event per (job, status).
        CONSTRAINT uq_webhook_events_job_status UNIQUE (job_id, status),
        CONSTRAINT ck_webhook_events_status
          CHECK (status IN ('SENT', 'FAILED', 'DEAD_LETTERED'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_webhook_events_due
        ON webhook_events (next_attempt_at)
        WHERE delivered_at IS NULL AND failed_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE mock_webhook_receipts (
        event_id           uuid        NOT NULL,
        job_id             uuid        NOT NULL,
        status             varchar(16) NOT NULL,
        received_count     integer     NOT NULL DEFAULT 1,
        first_received_at  timestamptz NOT NULL DEFAULT now(),
        last_received_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_mock_webhook_receipts PRIMARY KEY (event_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE mock_webhook_receipts');
    await queryRunner.query('DROP TABLE webhook_events');
  }
}
