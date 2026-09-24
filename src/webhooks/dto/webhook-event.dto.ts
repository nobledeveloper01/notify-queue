import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsUUID, Min } from 'class-validator';
import { JobStatus } from '../../common/enums/job-status.enum.js';

export const WEBHOOK_STATUSES = [JobStatus.Sent, JobStatus.Failed, JobStatus.DeadLettered] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

/** The body POSTed to WEBHOOK_URL when a job reaches a terminal status. */
export class WebhookEventDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Stable across redeliveries; dedupe on it.',
  })
  @IsUUID()
  eventId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  jobId: string;

  @ApiProperty({ enum: WEBHOOK_STATUSES, enumName: 'WebhookStatus', example: JobStatus.Sent })
  @IsIn(WEBHOOK_STATUSES)
  status: WebhookStatus;

  @ApiProperty({ example: 2, description: 'Delivery attempts the job took.' })
  @IsInt()
  @Min(0)
  attemptCount: number;

  @ApiProperty({ format: 'date-time', description: 'When the job reached this status.' })
  @IsISO8601({ strict: true })
  timestamp: string;
}
