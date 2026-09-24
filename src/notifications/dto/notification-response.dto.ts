import { ApiProperty } from '@nestjs/swagger';
import { JobPriority } from '../../common/enums/job-priority.enum.js';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import { NotificationChannel } from '../../common/enums/notification-channel.enum.js';
import type { NotificationJob } from '../entities/notification-job.entity.js';

/**
 * What the API says about a job. Deliberately omits the payload (the client
 * already has it, and it may be sensitive) and the claim internals.
 */
export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid', example: '3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c' })
  id: string;

  @ApiProperty({ example: 'welcome-user-123' })
  idempotencyKey: string;

  @ApiProperty({ example: 'user@example.com' })
  recipient: string;

  @ApiProperty({ enum: NotificationChannel, enumName: 'NotificationChannel' })
  channel: NotificationChannel;

  @ApiProperty({ enum: JobPriority, enumName: 'JobPriority' })
  priority: JobPriority;

  @ApiProperty({ enum: JobStatus, enumName: 'JobStatus', example: JobStatus.Pending })
  status: JobStatus;

  @ApiProperty({ format: 'date-time', description: 'When the job was first due.' })
  scheduledAt: string;

  @ApiProperty({ format: 'date-time', description: 'When the job is next due (moves on retry).' })
  nextAttemptAt: string;

  @ApiProperty({ example: 0, description: 'Delivery attempts started so far.' })
  attemptCount: number;

  @ApiProperty({ example: 6 })
  maxAttempts: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  lastError: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  sentAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  failedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  deadLetteredAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt: string | null;

  @ApiProperty({
    example: 0,
    description: 'Times this job was sent back to the queue with POST /notifications/:id/retry.',
  })
  redriveCount: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  lastRedrivenAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  static fromEntity(job: NotificationJob): NotificationResponseDto {
    const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
    return {
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      recipient: job.recipient,
      channel: job.channel,
      priority: job.priority,
      status: job.status,
      scheduledAt: job.scheduledAt.toISOString(),
      nextAttemptAt: job.nextAttemptAt.toISOString(),
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      sentAt: iso(job.sentAt),
      failedAt: iso(job.failedAt),
      deadLetteredAt: iso(job.deadLetteredAt),
      cancelledAt: iso(job.cancelledAt),
      redriveCount: job.redriveCount,
      lastRedrivenAt: iso(job.lastRedrivenAt),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }
}
