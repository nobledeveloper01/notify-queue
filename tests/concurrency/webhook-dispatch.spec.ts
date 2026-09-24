import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { WebhookService } from '../../src/webhooks/webhook.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import { startWebhookReceiver } from '../support/webhook-receiver.js';

describe('webhook dispatch with concurrent dispatchers (PostgreSQL)', () => {
  let admin: DataSource;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    admin = await createTestDataSource();
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await admin.destroy();
  });

  beforeEach(async () => {
    await truncateAll(admin);
  });

  it('delivers each of 60 events once when 6 dispatchers run at the same moment', async () => {
    const receiver = await startWebhookReceiver();
    try {
      const jobs = new NotificationJobRepository(admin);
      await Promise.all(Array.from({ length: 60 }, () => jobs.insertIfAbsent(newJob())));
      const { claimToken, jobs: claimed } = await jobs.claimDueJobs('worker-a', 60);
      await Promise.all(claimed.map((j) => jobs.markSent(j.id, claimToken)));

      for (let i = 0; i < 6; i++) {
        apps.push(
          await createTestApp({
            listen: false,
            env: { WEBHOOK_URL: receiver.url, DATABASE_POOL_MAX: '3' },
          }),
        );
      }
      const dispatchers = apps.map((a) => a.get(WebhookService));

      const reports = await Promise.all(dispatchers.map((d) => d.dispatchDue()));

      expect(reports.reduce((sum, r) => sum + r.delivered, 0)).toBe(60);
      expect(receiver.received).toHaveLength(60);
      expect(new Set(receiver.received.map((r) => r.body.eventId)).size).toBe(60);
    } finally {
      await receiver.close();
    }
  });
});
