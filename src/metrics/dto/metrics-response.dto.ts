import { ApiProperty } from '@nestjs/swagger';

export class WebhookMetricsDto {
  @ApiProperty({ example: 0 })
  pending: number;

  @ApiProperty({ example: 104 })
  delivered: number;

  @ApiProperty({ example: 0, description: 'Events abandoned after WEBHOOK_MAX_ATTEMPTS.' })
  givenUp: number;
}

export class MetricsResponseDto {
  @ApiProperty({ example: 10 })
  pending: number;

  @ApiProperty({ example: 2 })
  processing: number;

  @ApiProperty({ example: 100 })
  sent: number;

  @ApiProperty({ example: 3 })
  failed: number;

  @ApiProperty({ example: 1 })
  deadLettered: number;

  @ApiProperty({
    example: 0.4,
    description:
      'How long the oldest due job has waited to be claimed. Rising lag means workers are not keeping up.',
  })
  queueLagSeconds: number;

  @ApiProperty({ type: WebhookMetricsDto })
  webhooks: WebhookMetricsDto;
}
