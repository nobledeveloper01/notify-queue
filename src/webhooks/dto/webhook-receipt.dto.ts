import { ApiProperty } from '@nestjs/swagger';

export class WebhookReceiptDto {
  @ApiProperty({ format: 'uuid' })
  eventId: string;

  @ApiProperty({ description: 'True if this event ID had been received before.' })
  duplicate: boolean;

  @ApiProperty({ example: 1, description: 'Times this event ID has been received.' })
  receivedCount: number;
}
