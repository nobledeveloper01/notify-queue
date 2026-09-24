import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ValueTransformer } from 'typeorm';
import {
  JOB_PRIORITY_RANK,
  JobPriority,
  priorityFromRank,
} from '../../common/enums/job-priority.enum.js';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import { NotificationChannel } from '../../common/enums/notification-channel.enum.js';

const priorityTransformer: ValueTransformer = {
  to: (priority: JobPriority) => JOB_PRIORITY_RANK[priority],
  from: (rank: number) => priorityFromRank(rank),
};

/**
 * Persistence model for a notification job. The schema itself (constraints,
 * partial indexes) is owned by the migration in
 * `database/migrations/1790208000000-create-notification-jobs.ts`; this class
 * only maps columns.
 */
@Entity({ name: 'notification_jobs' })
export class NotificationJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 320 })
  recipient: string;

  @Column({ type: 'varchar', length: 16 })
  channel: NotificationChannel;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'smallint', transformer: priorityTransformer })
  priority: JobPriority;

  @Column({ type: 'varchar', length: 16, default: JobStatus.Pending })
  status: JobStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ name: 'max_attempts', type: 'integer' })
  maxAttempts: number;

  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @Column({ name: 'locked_by', type: 'varchar', length: 128, nullable: true })
  lockedBy: string | null;

  /**
   * Fencing token, fresh on every claim. Status updates after delivery must
   * present it, so a worker whose lease expired (and whose job was reclaimed)
   * cannot overwrite the new owner's result.
   */
  @Column({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @Column({ name: 'dead_lettered_at', type: 'timestamptz', nullable: true })
  deadLetteredAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
