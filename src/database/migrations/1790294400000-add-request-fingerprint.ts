import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores a hash of the request that created each job, so a retried request
 * (same idempotency key, same body) can be told apart from a key reused for a
 * different notification, which must be rejected rather than silently merged.
 *
 * Nullable on purpose: jobs created before this migration have no recorded
 * request, and no backfill could reconstruct one. NULL means "unknown", and
 * the service accepts a replay of such a job rather than guessing.
 */
export class AddRequestFingerprint1790294400000 implements MigrationInterface {
  name = 'AddRequestFingerprint1790294400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE notification_jobs ADD COLUMN request_fingerprint char(64)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification_jobs DROP COLUMN request_fingerprint');
  }
}
