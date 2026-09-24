import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When the claim on a job's final attempt expires, the worker may have
 * crashed *after* the provider accepted the notification. Dead-lettering it
 * then would report a delivered notification as undeliverable. Instead,
 * recovery grants one extra attempt: resending with the same delivery key
 * either finds it already delivered (the provider deduplicates) or delivers
 * it. The flag makes the grant once per job, so a job that crashes every
 * worker is still bounded and ends in DEAD_LETTERED.
 */
export class AddReconciliationGrant1790640000000 implements MigrationInterface {
  name = 'AddReconciliationGrant1790640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE notification_jobs ADD COLUMN reconciliation_granted boolean NOT NULL DEFAULT false',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification_jobs DROP COLUMN reconciliation_granted');
  }
}
