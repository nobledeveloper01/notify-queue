import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';

const REQUESTS = 25;

const body = (recipient = 'user@example.com') => ({
  recipient,
  channel: 'EMAIL',
  payload: { subject: 'Hi' },
  priority: 'NORMAL',
  delaySeconds: 60,
  idempotencyKey: 'burst-key',
});

describe('idempotency under concurrent requests (PostgreSQL)', () => {
  let dataSource: DataSource;
  let app: NestExpressApplication;

  const countJobs = async (): Promise<number> => {
    const [{ count }]: { count: string }[] = await dataSource.query(
      'SELECT count(*) FROM notification_jobs',
    );
    return Number(count);
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  it(`turns ${REQUESTS} simultaneous identical POSTs into one job`, async () => {
    const responses = await Promise.all(
      Array.from({ length: REQUESTS }, () =>
        request(app.getHttpServer()).post('/notifications').send(body()),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(REQUESTS - 1);
    expect(new Set(responses.map((r) => r.body.id as string)).size).toBe(1);
    expect(await countJobs()).toBe(1);
  });

  it('lets exactly one body win when two different requests race for one key', async () => {
    const recipientFor = (i: number) => (i % 2 === 0 ? 'a@example.com' : 'b@example.com');

    const responses = await Promise.all(
      Array.from({ length: REQUESTS }, (_, i) =>
        request(app.getHttpServer())
          .post('/notifications')
          .send(body(recipientFor(i))),
      ),
    );

    const [job]: { recipient: string }[] = await dataSource.query(
      'SELECT recipient FROM notification_jobs',
    );
    const sameBodyAsWinner = responses.filter((_, i) => recipientFor(i) === job.recipient);
    const otherBody = responses.filter((_, i) => recipientFor(i) !== job.recipient);

    expect(await countJobs()).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(sameBodyAsWinner.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(otherBody.every((r) => r.status === 409)).toBe(true);
  });

  it('holds across separate API instances with separate connection pools', async () => {
    const replicas = await Promise.all(Array.from({ length: 8 }, () => createTestDataSource(2)));
    try {
      const input = newJob({ idempotencyKey: 'replica-key' });

      const outcomes = await Promise.all(
        replicas.map((ds) => new NotificationJobRepository(ds).insertIfAbsent(input)),
      );

      expect(outcomes.filter((o) => o.created)).toHaveLength(1);
      expect(new Set(outcomes.map((o) => o.job.id)).size).toBe(1);
      expect(await countJobs()).toBe(1);
    } finally {
      await Promise.all(replicas.map((ds) => ds.destroy()));
    }
  });
});
