import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_SCHEDULE_AHEAD_SECONDS } from '../../common/constants/job.constants.js';
import { JobPriority } from '../../common/enums/job-priority.enum.js';
import { NotificationChannel } from '../../common/enums/notification-channel.enum.js';
import { IsSendAt } from './validators/is-send-at.validator.js';

export class ScheduleNotificationDto {
  @ApiProperty({
    description: 'Where to deliver: an email address, phone number or device token.',
    example: 'user@example.com',
    maxLength: 320,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  recipient: string;

  @ApiProperty({
    enum: NotificationChannel,
    enumName: 'NotificationChannel',
    example: NotificationChannel.Email,
  })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @ApiProperty({
    description: 'Channel-specific content. Stored as JSONB; never written to logs.',
    type: 'object',
    additionalProperties: true,
    example: { subject: 'Welcome', body: 'Welcome to Notify Queue' },
  })
  @IsObject()
  payload: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Absolute delivery time, ISO 8601 with an explicit offset. Exactly one of sendAt or delaySeconds is required. A time in the past is due immediately.',
    example: '2026-09-27T12:00:00.000Z',
    format: 'date-time',
  })
  @IsSendAt()
  sendAt?: string;

  @ApiPropertyOptional({
    description: 'Delay from now, in seconds. Exactly one of sendAt or delaySeconds is required.',
    example: 60,
    minimum: 1,
    maximum: MAX_SCHEDULE_AHEAD_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SCHEDULE_AHEAD_SECONDS)
  delaySeconds?: number;

  @ApiProperty({
    enum: JobPriority,
    enumName: 'JobPriority',
    example: JobPriority.High,
  })
  @IsEnum(JobPriority)
  priority: JobPriority;

  @ApiProperty({
    description:
      'Client-chosen key. Repeating a request with the same key and body returns the original job; reusing the key for a different body is rejected with 409.',
    example: 'welcome-user-123',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey: string;
}
