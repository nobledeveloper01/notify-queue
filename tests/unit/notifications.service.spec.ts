import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JobPriority } from '../../src/common/enums/job-priority.enum.js';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationChannel } from '../../src/common/enums/notification-channel.enum.js';
import { IdempotencyKeyReuseException } from '../../src/common/exceptions/idempotency.exception.js';
import type { AppConfig } from '../../src/config/configuration.js';
import type { ScheduleNotificationDto } from '../../src/notifications/dto/schedule-notification.dto.js';
import type { NotificationJob } from '../../src/notifications/entities/notification-job.entity.js';
import type {
  NewNotificationJob,
  NotificationJobRepository,
} from '../../src/notifications/repositories/notification-job.repository.js';
import { NotificationsService } from '../../src/notifications/services/notifications.service.js';

const dto = (overrides: Partial<ScheduleNotificationDto> = {}): ScheduleNotificationDto => ({
  recipient: 'user@example.com',
  channel: NotificationChannel.Email,
  payload: { subject: 'Hi', body: 'There' },
  priority: JobPriority.Normal,
  idempotencyKey: 'key-1',
  delaySeconds: 60,
  ...overrides,
});

const jobFrom = (input: NewNotificationJob): NotificationJob => {
  const now = new Date();
  return {
    id: '3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c',
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    recipient: input.recipient,
    channel: input.channel,
    payload: input.payload,
    priority: input.priority,
    status: JobStatus.Pending,
    scheduledAt: now,
    nextAttemptAt: now,
    attemptCount: 0,
    maxAttempts: input.maxAttempts,
    reconciliationGranted: false,
    cancelledAt: null,
    redriveCount: 0,
    lastRedrivenAt: null,
    lockedAt: null,
    lockedBy: null,
    claimToken: null,
    lastError: null,
    sentAt: null,
    failedAt: null,
    deadLetteredAt: null,
    createdAt: now,
    updatedAt: now,
  };
};

describe('NotificationsService', () => {
  let stored: NotificationJob | null;
  let insertIfAbsent: jest.Mock<NotificationJobRepository['insertIfAbsent']>;
  let findById: jest.Mock<NotificationJobRepository['findById']>;
  let service: NotificationsService;

  beforeEach(() => {
    stored = null;
    // Behaves like the real repository: first insert wins, later ones get the stored job.
    insertIfAbsent = jest.fn((input: NewNotificationJob) => {
      if (stored) return Promise.resolve({ job: stored, created: false });
      stored = jobFrom(input);
      return Promise.resolve({ job: stored, created: true });
    });
    findById = jest.fn((_id: string) => Promise.resolve(stored));
    // Mirror the repository's conditional updates on the in-memory job.
    const cancelPending = jest.fn(() => {
      if (stored?.status !== JobStatus.Pending) return Promise.resolve(false);
      stored.status = JobStatus.Cancelled;
      stored.cancelledAt = new Date();
      return Promise.resolve(true);
    });
    const redrive = jest.fn((_id: string, maxAttempts: number) => {
      if (stored?.status !== JobStatus.DeadLettered && stored?.status !== JobStatus.Failed) {
        return Promise.resolve(false);
      }
      Object.assign(stored, {
        status: JobStatus.Pending,
        attemptCount: 0,
        maxAttempts,
        redriveCount: stored.redriveCount + 1,
        lastRedrivenAt: new Date(),
      });
      return Promise.resolve(true);
    });
    const repository = {
      insertIfAbsent,
      findById,
      cancelPending,
      redrive,
    } as unknown as NotificationJobRepository;
    const config = {
      get: (key: keyof AppConfig) =>
        key === 'retry' ? { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 60000 } : undefined,
    } as unknown as ConfigService<AppConfig, true>;
    service = new NotificationsService(repository, config);
  });

  describe('schedule', () => {
    it('queues a delayed job with maxRetries + 1 attempts', async () => {
      const { notification, created } = await service.schedule(dto({ delaySeconds: 90 }));

      expect(created).toBe(true);
      expect(notification.status).toBe(JobStatus.Pending);
      const [input] = insertIfAbsent.mock.calls[0];
      expect(input.schedule).toEqual({ delaySeconds: 90 });
      expect(input.maxAttempts).toBe(6);
      expect(input.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('queues an absolute-time job', async () => {
      const sendAt = '2026-12-01T09:30:00+01:00';

      await service.schedule(dto({ delaySeconds: undefined, sendAt }));

      expect(insertIfAbsent.mock.calls[0][0].schedule).toEqual({ sendAt: new Date(sendAt) });
    });

    it('returns the original job when the same request is replayed', async () => {
      const first = await service.schedule(dto());
      const replay = await service.schedule(dto({ payload: { body: 'There', subject: 'Hi' } }));

      expect(replay.created).toBe(false);
      expect(replay.notification.id).toBe(first.notification.id);
    });

    it('treats the same instant in another offset as the same request', async () => {
      await service.schedule(dto({ delaySeconds: undefined, sendAt: '2026-12-01T08:30:00Z' }));

      await expect(
        service.schedule(dto({ delaySeconds: undefined, sendAt: '2026-12-01T09:30:00+01:00' })),
      ).resolves.toMatchObject({ created: false });
    });

    it('rejects an idempotency key reused for a different notification', async () => {
      await service.schedule(dto());

      await expect(service.schedule(dto({ recipient: 'other@example.com' }))).rejects.toThrow(
        IdempotencyKeyReuseException,
      );
    });

    it('accepts a replay of a job created before fingerprints were recorded', async () => {
      await service.schedule(dto());
      if (stored) stored.requestFingerprint = null;

      await expect(
        service.schedule(dto({ recipient: 'other@example.com' })),
      ).resolves.toMatchObject({ created: false });
    });

    it.each([
      ['neither', { delaySeconds: undefined }],
      ['both', { sendAt: '2026-12-01T08:30:00Z' }],
    ])('rejects %s sendAt and delaySeconds', async (_, overrides) => {
      await expect(service.schedule(dto(overrides))).rejects.toThrow(BadRequestException);
      expect(insertIfAbsent).not.toHaveBeenCalled();
    });

    it('rejects a sendAt more than a year ahead', async () => {
      const tooFar = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();

      await expect(
        service.schedule(dto({ delaySeconds: undefined, sendAt: tooFar })),
      ).rejects.toThrow(/365 days/);
    });
  });

  describe('findById', () => {
    it('maps the job to the response shape without the payload', async () => {
      await service.schedule(dto());

      const found = await service.findById('3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c');

      expect(found.idempotencyKey).toBe('key-1');
      expect(found).not.toHaveProperty('payload');
      expect(found).not.toHaveProperty('claimToken');
    });

    it('throws NotFound for an unknown job', async () => {
      await expect(service.findById('3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancel', () => {
    it('cancels a pending job, and repeating it returns the same job', async () => {
      const { notification } = await service.schedule(dto());

      const first = await service.cancel(notification.id);
      const again = await service.cancel(notification.id);

      expect(first.status).toBe(JobStatus.Cancelled);
      expect(again).toEqual(first);
    });

    it('refuses a job that is no longer pending', async () => {
      const { notification } = await service.schedule(dto());
      if (stored) stored.status = JobStatus.Processing;

      await expect(service.cancel(notification.id)).rejects.toThrow(ConflictException);
    });

    it('returns 404 for an unknown job', async () => {
      await expect(service.cancel('3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('redrive', () => {
    it('gives a dead-lettered job a fresh budget of maxRetries + 1 attempts', async () => {
      const { notification } = await service.schedule(dto());
      if (stored) Object.assign(stored, { status: JobStatus.DeadLettered, attemptCount: 6 });

      const redriven = await service.redrive(notification.id);

      expect(redriven).toMatchObject({
        status: JobStatus.Pending,
        attemptCount: 0,
        maxAttempts: 6,
        redriveCount: 1,
      });
    });

    it.each([JobStatus.Pending, JobStatus.Processing, JobStatus.Sent, JobStatus.Cancelled])(
      'refuses a %s job',
      async (status) => {
        const { notification } = await service.schedule(dto());
        if (stored) stored.status = status;

        await expect(service.redrive(notification.id)).rejects.toThrow(ConflictException);
      },
    );
  });
});
