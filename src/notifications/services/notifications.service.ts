import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import {
  MAX_SCHEDULE_AHEAD_SECONDS,
  SCHEDULE_EXACTLY_ONE_MESSAGE,
} from '../../common/constants/job.constants.js';
import { IdempotencyKeyReuseException } from '../../common/exceptions/idempotency.exception.js';
import { fingerprintRequest } from '../../common/utils/idempotency.util.js';
import { NotificationResponseDto } from '../dto/notification-response.dto.js';
import type { ScheduleNotificationDto } from '../dto/schedule-notification.dto.js';
import { NotificationJobRepository } from '../repositories/notification-job.repository.js';
import type { JobSchedule } from '../repositories/notification-job.repository.js';

export interface ScheduleResult {
  notification: NotificationResponseDto;
  /** False when the idempotency key replayed an existing job. */
  created: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly maxAttempts: number;

  constructor(
    private readonly jobs: NotificationJobRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxAttempts = config.get('retry', { infer: true }).maxRetries + 1;
  }

  /**
   * Schedules a notification, or returns the job an earlier identical request
   * created. Duplicate detection is decided by the database's unique
   * constraint, not by a read-then-write check here, so concurrent duplicates
   * are safe. A key reused with a different body is a client error (409),
   * never a silent merge.
   */
  async schedule(dto: ScheduleNotificationDto): Promise<ScheduleResult> {
    const schedule = this.resolveSchedule(dto);
    const requestFingerprint = fingerprintRequest({
      recipient: dto.recipient,
      channel: dto.channel,
      payload: dto.payload,
      priority: dto.priority,
      sendAt: 'sendAt' in schedule ? schedule.sendAt.toISOString() : undefined,
      delaySeconds: 'delaySeconds' in schedule ? schedule.delaySeconds : undefined,
    });

    const { job, created } = await this.jobs.insertIfAbsent({
      idempotencyKey: dto.idempotencyKey,
      requestFingerprint,
      recipient: dto.recipient,
      channel: dto.channel,
      payload: dto.payload,
      priority: dto.priority,
      schedule,
      maxAttempts: this.maxAttempts,
    });

    if (
      !created &&
      job.requestFingerprint !== null &&
      job.requestFingerprint !== requestFingerprint
    ) {
      throw new IdempotencyKeyReuseException(dto.idempotencyKey);
    }
    return { notification: NotificationResponseDto.fromEntity(job), created };
  }

  async findById(id: string): Promise<NotificationResponseDto> {
    const job = await this.jobs.findById(id);
    if (!job) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    return NotificationResponseDto.fromEntity(job);
  }

  /**
   * The DTO already enforces "exactly one of"; this re-checks it because the
   * service is the owner of scheduling rules, whoever its caller is, and adds
   * the rule the DTO cannot know: how far ahead is too far.
   */
  private resolveSchedule({ sendAt, delaySeconds }: ScheduleNotificationDto): JobSchedule {
    if ((sendAt === undefined) === (delaySeconds === undefined)) {
      throw new BadRequestException(SCHEDULE_EXACTLY_ONE_MESSAGE);
    }
    if (delaySeconds !== undefined) {
      return { delaySeconds };
    }

    const at = new Date(sendAt as string);
    if (at.getTime() - Date.now() > MAX_SCHEDULE_AHEAD_SECONDS * 1000) {
      throw new BadRequestException('sendAt must be within 365 days from now');
    }
    return { sendAt: at };
  }
}
