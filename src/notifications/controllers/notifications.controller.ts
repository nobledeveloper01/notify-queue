import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
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
import { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto.js';
import { NotificationPageDto } from '../dto/notification-page.dto.js';
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

  @Get()
  @ApiOperation({
    summary: 'List notification jobs',
    description:
      'Newest first, filtered by status and/or recipient, paginated with an opaque cursor. For example `?status=DEAD_LETTERED` lists the dead-letter queue.',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Invalid filter or cursor.' })
  list(@Query() query: ListNotificationsQueryDto): Promise<NotificationPageDto> {
    return this.notificationsService.list(query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a pending notification',
    description:
      'Only a PENDING job can be cancelled; once a worker has claimed it, the answer is 409. Cancelling an already cancelled job returns it unchanged.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NotificationResponseDto, description: 'Now CANCELLED.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Already processing or finished.' })
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.cancel(id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redrive a dead-lettered or failed notification',
    description:
      'Sends a DEAD_LETTERED or FAILED job back to the queue, due now, with a fresh attempt budget. The redrive is counted on the job (redriveCount, lastRedrivenAt).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NotificationResponseDto, description: 'Now PENDING.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The job is not DEAD_LETTERED or FAILED.',
  })
  redrive(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.redrive(id);
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
