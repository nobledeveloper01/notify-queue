import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sliding-window rate limiting: one row per notification admitted for
 * delivery. A recipient is under the limit while fewer than N of its rows
 * fall inside the last window. Keyed by job so a retried or recovered job
 * reuses its reservation instead of counting twice.
 */
export class CreateRateLimitReservations1790467200000 implements MigrationInterface {
  name = 'CreateRateLimitReservations1790467200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE rate_limit_reservations (
        job_id       uuid         NOT NULL,
        recipient    varchar(320) NOT NULL,
        reserved_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT pk_rate_limit_reservations PRIMARY KEY (job_id),
        CONSTRAINT fk_rate_limit_reservations_job
          FOREIGN KEY (job_id) REFERENCES notification_jobs (id) ON DELETE CASCADE
      )
    `);
    // The admission query: WHERE recipient = $1 AND reserved_at > now() - window.
    await queryRunner.query(`
      CREATE INDEX idx_rate_limit_reservations_recipient_time
        ON rate_limit_reservations (recipient, reserved_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE rate_limit_reservations');
  }
}
