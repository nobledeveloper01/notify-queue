import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import { NoNullCharacters } from '../../common/validators/no-null-characters.validator.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    enum: JobStatus,
    enumName: 'JobStatus',
    description: 'Only jobs in this status, e.g. DEAD_LETTERED to inspect the dead-letter queue.',
  })
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @ApiPropertyOptional({ example: 'user@example.com', description: 'Exact recipient match.' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  @NoNullCharacters()
  recipient?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: 'Page size.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description: 'The nextCursor from the previous page. Omit for the first page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
