import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operator actions and listing:
 *
 * - CANCELLED status (with its timestamp) for jobs cancelled while PENDING.
 * - `redrive_count` / `last_redriven_at`: the audit trail for moving a
 *   DEAD_LETTERED or FAILED job back to the queue.
 * - Webhook events become unique per (job, status, redrive generation): a
 *   redriven job can legitimately reach DEAD_LETTERED again, and that second
 *   event must not collide with the first.
 * - Indexes for keyset-paginated listing, newest first, by status or overall.
 *   (Filtering by recipient uses the existing (recipient, created_at) index.)
 *
 * On a large live table these indexes would be built with CREATE INDEX
 * CONCURRENTLY in a migration that runs outside a transaction.
 */
export class AddCancelRedriveAndListing1790726400000 implements MigrationInterface {
  name = 'AddCancelRedriveAndListing1790726400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notification_jobs
        DROP CONSTRAINT ck_notification_jobs_status,
        ADD CONSTRAINT ck_notification_jobs_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')),
        ADD COLUMN cancelled_at timestamptz,
        ADD COLUMN redrive_count integer NOT NULL DEFAULT 0,
        ADD COLUMN last_redriven_at timestamptz,
        ADD CONSTRAINT ck_notification_jobs_cancelled_at
          CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
        ADD CONSTRAINT ck_notification_jobs_redrive_count
          CHECK (redrive_count >= 0 AND (redrive_count = 0) = (last_redriven_at IS NULL))
    `);

    await queryRunner.query(`
      CREATE INDEX idx_notification_jobs_status_created
        ON notification_jobs (status, created_at DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_jobs_created
        ON notification_jobs (created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      ALTER TABLE webhook_events
        ADD COLUMN redrive_count integer NOT NULL DEFAULT 0,
        DROP CONSTRAINT uq_webhook_events_job_status,
        ADD CONSTRAINT uq_webhook_events_job_status_generation
          UNIQUE (job_id, status, redrive_count)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting cannot represent cancelled jobs or repeated terminal events.
    await queryRunner.query(`
      ALTER TABLE webhook_events
        DROP CONSTRAINT uq_webhook_events_job_status_generation,
        ADD CONSTRAINT uq_webhook_events_job_status UNIQUE (job_id, status),
        DROP COLUMN redrive_count
    `);
    await queryRunner.query('DROP INDEX idx_notification_jobs_created');
    await queryRunner.query('DROP INDEX idx_notification_jobs_status_created');
    await queryRunner.query(`
      ALTER TABLE notification_jobs
        DROP CONSTRAINT ck_notification_jobs_redrive_count,
        DROP CONSTRAINT ck_notification_jobs_cancelled_at,
        DROP COLUMN last_redriven_at,
        DROP COLUMN redrive_count,
        DROP COLUMN cancelled_at,
        DROP CONSTRAINT ck_notification_jobs_status,
        ADD CONSTRAINT ck_notification_jobs_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTERED'))
    `);
  }
}
