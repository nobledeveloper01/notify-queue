import { ApiProperty } from '@nestjs/swagger';
import { NotificationResponseDto } from './notification-response.dto.js';

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationResponseDto], description: 'Newest first.' })
  items: NotificationResponseDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `cursor` to fetch the next page; null on the last page.',
  })
  nextCursor: string | null;
}
