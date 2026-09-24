import { randomUUID } from 'node:crypto';
import { JobPriority } from '../../src/common/enums/job-priority.enum.js';
import { NotificationChannel } from '../../src/common/enums/notification-channel.enum.js';
import type { NewNotificationJob } from '../../src/notifications/repositories/notification-job.repository.js';

/** A due, valid job; override only what the test is about. */
export const newJob = (overrides: Partial<NewNotificationJob> = {}): NewNotificationJob => ({
  idempotencyKey: `test-${randomUUID()}`,
  recipient: 'user@example.com',
  channel: NotificationChannel.Email,
  payload: { subject: 'Hello', body: 'World' },
  priority: JobPriority.Normal,
  scheduledAt: new Date(Date.now() - 1000),
  maxAttempts: 3,
  ...overrides,
});
