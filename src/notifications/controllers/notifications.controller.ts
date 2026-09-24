import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  REQUEST_ID_HEADER,
} from '../../common/constants/app.constants.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { NotificationResponseDto } from '../dto/notification-response.dto.js';
import { ScheduleNotificationDto } from '../dto/schedule-notification.dto.js';
import { NotificationsService } from '../services/notifications.service.js';

@ApiTags('Notifications')
@ApiHeader({
  name: REQUEST_ID_HEADER,
  required: false,
  description: 'Correlation ID; generated if absent and echoed on every response.',
})
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Schedule a notification',
    description:
      'Queues a notification for delivery at `sendAt` or after `delaySeconds`. Safe to retry: the same `idempotencyKey` and body return the original job with 200 instead of creating another.',
  })
  @ApiBody({ type: ScheduleNotificationDto })
  @ApiCreatedResponse({ type: NotificationResponseDto, description: 'Job created.' })
  @ApiOkResponse({
    type: NotificationResponseDto,
    description: `Replay of an earlier identical request; \`${IDEMPOTENT_REPLAYED_HEADER}: true\`.`,
  })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Validation failed.' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The idempotency key was already used for a different request.',
  })
  async schedule(
    @Body() dto: ScheduleNotificationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationResponseDto> {
    const { notification, created } = await this.notificationsService.schedule(dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    res.setHeader(IDEMPOTENT_REPLAYED_HEADER, String(!created));
    return notification;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a notification job and its delivery status' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Job ID returned when scheduling.' })
  @ApiOkResponse({ type: NotificationResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'The ID is not a UUID.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  findById(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.findById(id);
  }
}
