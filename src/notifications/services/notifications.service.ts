import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import {
  MAX_SCHEDULE_AHEAD_SECONDS,
  SCHEDULE_EXACTLY_ONE_MESSAGE,
} from '../../common/constants/job.constants.js';
import { IdempotencyKeyReuseException } from '../../common/exceptions/idempotency.exception.js';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util.js';
import { fingerprintRequest } from '../../common/utils/idempotency.util.js';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import { OPERATOR_TRANSITIONS } from '../domain/job-state-machine.js';
import { DEFAULT_PAGE_SIZE } from '../dto/list-notifications-query.dto.js';
import type { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto.js';
import type { NotificationPageDto } from '../dto/notification-page.dto.js';
import { NotificationResponseDto } from '../dto/notification-response.dto.js';
import type { ScheduleNotificationDto } from '../dto/schedule-notification.dto.js';
import { NotificationJobRepository } from '../repositories/notification-job.repository.js';
import type { JobSchedule } from '../repositories/notification-job.repository.js';
import type { NotificationJob } from '../entities/notification-job.entity.js';

export interface ScheduleResult {
  notification: NotificationResponseDto;
  /** False when the idempotency key replayed an existing job. */
  created: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
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
    return NotificationResponseDto.fromEntity(await this.getJob(id));
  }

  async list(query: ListNotificationsQueryDto): Promise<NotificationPageDto> {
    const page = await this.jobs.list({
      status: query.status,
      recipient: query.recipient,
      after: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    return {
      items: page.jobs.map((job) => NotificationResponseDto.fromEntity(job)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  /**
   * Cancels a job that has not started. Repeating the call on a cancelled job
   * returns it unchanged, so the request is safe to retry. A job a worker has
   * already claimed can no longer be cancelled: 409.
   */
  async cancel(id: string): Promise<NotificationResponseDto> {
    if (await this.jobs.cancelPending(id)) {
      const job = await this.getJob(id);
      this.logger.log({ event: 'job.cancelled', jobId: id });
      return NotificationResponseDto.fromEntity(job);
    }

    const job = await this.getJob(id);
    if (job.status === JobStatus.Cancelled) {
      return NotificationResponseDto.fromEntity(job);
    }
    throw new ConflictException(
      `Notification ${id} is ${job.status}; only ${OPERATOR_TRANSITIONS.cancel.from.join(', ')} jobs can be cancelled`,
    );
  }

  /**
   * Sends a DEAD_LETTERED or FAILED job back to the queue with a fresh attempt
   * budget: the manual redrive for a dead-letter queue. Each redrive is
   * counted on the job and logged, so it is auditable.
   */
  async redrive(id: string): Promise<NotificationResponseDto> {
    if (!(await this.jobs.redrive(id, this.maxAttempts))) {
      const job = await this.getJob(id);
      throw new ConflictException(
        `Notification ${id} is ${job.status}; only ${OPERATOR_TRANSITIONS.redrive.from.join(' or ')} jobs can be retried`,
      );
    }
    const job = await this.getJob(id);
    this.logger.warn({
      event: 'job.redriven',
      jobId: id,
      redriveCount: job.redriveCount,
      previousError: job.lastError,
    });
    return NotificationResponseDto.fromEntity(job);
  }

  private async getJob(id: string): Promise<NotificationJob> {
    const job = await this.jobs.findById(id);
    if (!job) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    return job;
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
