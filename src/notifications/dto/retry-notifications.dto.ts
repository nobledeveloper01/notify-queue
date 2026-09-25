import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import { NoNullCharacters } from '../../common/validators/no-null-characters.validator.js';
import { OPERATOR_TRANSITIONS } from '../domain/job-state-machine.js';

export const DEFAULT_RETRY_BATCH_SIZE = 100;
export const MAX_RETRY_BATCH_SIZE = 1000;

export type RetryableStatus = (typeof OPERATOR_TRANSITIONS.redrive.from)[number];

/** Which dead-lettered or failed jobs to send back to the queue in one call. */
export class RetryNotificationsDto {
  @ApiPropertyOptional({
    enum: [...OPERATOR_TRANSITIONS.redrive.from],
    default: JobStatus.DeadLettered,
    description: 'Retry jobs in this status: the dead-letter queue, or permanently failed jobs.',
  })
  @IsOptional()
  @IsIn([...OPERATOR_TRANSITIONS.redrive.from])
  status?: RetryableStatus;

  @ApiPropertyOptional({
    example: 'user@example.com',
    description: 'Only jobs for this recipient. Exact match.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  @NoNullCharacters()
  recipient?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_RETRY_BATCH_SIZE,
    default: DEFAULT_RETRY_BATCH_SIZE,
    description: 'The most jobs to retry in this call, oldest first. Call again for the rest.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_RETRY_BATCH_SIZE)
  limit?: number;
}

export class RetryBatchResultDto {
  @ApiProperty({ example: 100, description: 'Jobs sent back to the queue by this call.' })
  retried: number;

  @ApiProperty({
    example: 250,
    description: 'Jobs that still match the filter. Call again until this is 0.',
  })
  remaining: number;
}
