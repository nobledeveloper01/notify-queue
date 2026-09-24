import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The job table. Invariants the application depends on are enforced here,
 * not only in TypeScript, so a bug or a manual UPDATE cannot violate them.
 */
export class CreateNotificationJobs1790208000000 implements MigrationInterface {
  name = 'CreateNotificationJobs1790208000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE notification_jobs (
        id                uuid         NOT NULL DEFAULT gen_random_uuid(),
        idempotency_key   varchar(255) NOT NULL,
        recipient         varchar(320) NOT NULL,
        channel           varchar(16)  NOT NULL,
        payload           jsonb        NOT NULL,
        priority          smallint     NOT NULL,
        status            varchar(16)  NOT NULL DEFAULT 'PENDING',
        scheduled_at      timestamptz  NOT NULL,
        next_attempt_at   timestamptz  NOT NULL,
        attempt_count     integer      NOT NULL DEFAULT 0,
        max_attempts      integer      NOT NULL,
        locked_at         timestamptz,
        locked_by         varchar(128),
        claim_token       uuid,
        last_error        text,
        sent_at           timestamptz,
        failed_at         timestamptz,
        dead_lettered_at  timestamptz,
        created_at        timestamptz  NOT NULL DEFAULT now(),
        updated_at        timestamptz  NOT NULL DEFAULT now(),

        CONSTRAINT pk_notification_jobs PRIMARY KEY (id),

        -- Two requests with one key can never create two jobs, even when they
        -- race past the application's "does it exist?" check.
        CONSTRAINT uq_notification_jobs_idempotency_key UNIQUE (idempotency_key),

        CONSTRAINT ck_notification_jobs_channel
          CHECK (channel IN ('EMAIL', 'SMS', 'PUSH')),
        CONSTRAINT ck_notification_jobs_priority
          CHECK (priority IN (1, 2, 3)),
        CONSTRAINT ck_notification_jobs_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTERED')),
        CONSTRAINT ck_notification_jobs_attempts
          CHECK (max_attempts > 0 AND attempt_count >= 0 AND attempt_count <= max_attempts),

        -- A job holds a claim if and only if it is PROCESSING. A job stuck in
        -- PROCESSING with no owner, or PENDING with a stale owner, is unrepresentable.
        CONSTRAINT ck_notification_jobs_claim
          CHECK (
            (status = 'PROCESSING')
            = (claim_token IS NOT NULL AND locked_by IS NOT NULL AND locked_at IS NOT NULL)
          ),

        -- Each terminal state carries the time it was reached.
        CONSTRAINT ck_notification_jobs_sent_at
          CHECK (status <> 'SENT' OR sent_at IS NOT NULL),
        CONSTRAINT ck_notification_jobs_failed_at
          CHECK (status <> 'FAILED' OR failed_at IS NOT NULL),
        CONSTRAINT ck_notification_jobs_dead_lettered_at
          CHECK (status <> 'DEAD_LETTERED' OR dead_lettered_at IS NOT NULL)
      )
    `);

    // The claim query: WHERE status = 'PENDING' AND next_attempt_at <= now()
    // ORDER BY priority DESC, next_attempt_at, created_at. Partial, so SENT and
    // dead-lettered rows (the bulk of the table over time) never bloat it.
    await queryRunner.query(`
      CREATE INDEX idx_notification_jobs_claimable
        ON notification_jobs (priority DESC, next_attempt_at ASC, created_at ASC)
        WHERE status = 'PENDING'
    `);

    // Stale-lease recovery: WHERE status = 'PROCESSING' AND locked_at < cutoff.
    await queryRunner.query(`
      CREATE INDEX idx_notification_jobs_stale_claims
        ON notification_jobs (locked_at)
        WHERE status = 'PROCESSING'
    `);

    // Per-recipient lookups (rate limiting, support queries).
    await queryRunner.query(`
      CREATE INDEX idx_notification_jobs_recipient_created
        ON notification_jobs (recipient, created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notification_jobs');
  }
}
