import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FieldErrorDto {
  @ApiProperty({ example: 'sendAt' })
  field: string;

  @ApiProperty({ type: [String], example: ['Provide exactly one of sendAt or delaySeconds'] })
  errors: string[];
}

/** The body of every error response. Never includes stack traces or SQL. */
export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({ example: 'Validation failed' })
  message: string;

  @ApiPropertyOptional({ type: [FieldErrorDto] })
  details?: FieldErrorDto[];

  @ApiProperty({ example: '/notifications' })
  path: string;

  @ApiProperty({ example: '5b0e8f9c-7a51-4e0a-b4c9-2f1d3e6a7b8c' })
  requestId: string;
}
