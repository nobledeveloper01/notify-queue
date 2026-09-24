import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { newJob } from '../support/job.factory.js';
import { LogCapture } from '../support/log-capture.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';

describe('Operations endpoints and logging (HTTP + PostgreSQL)', () => {
  let dataSource: DataSource;
  let jobs: NotificationJobRepository;
  let app: NestExpressApplication;
  let logs: LogCapture;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    jobs = new NotificationJobRepository(dataSource);
    logs = new LogCapture();
    app = await createTestApp({ env: { LOG_LEVEL: 'info' }, logDestination: logs });
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    logs.lines.length = 0;
  });

  describe('GET /metrics', () => {
    it('reports every status, zero-filled, from SQL aggregation', async () => {
      const due = await Promise.all([1, 2, 3].map(() => jobs.insertIfAbsent(newJob())));
      await jobs.insertIfAbsent(newJob({ schedule: { delaySeconds: 600 } }));
      const { claimToken } = await jobs.claimDueJobs('worker-a', 2);
      await jobs.markSent(due[0].job.id, claimToken);

      const res = await http.get('/metrics').expect(200);

      expect(res.body).toEqual({
        pending: 2,
        processing: 1,
        sent: 1,
        failed: 0,
        deadLettered: 0,
        cancelled: 0,
        queueLagSeconds: expect.any(Number),
        webhooks: { pending: 1, delivered: 0, givenUp: 0 },
      });
      expect(res.body.queueLagSeconds).toBeGreaterThan(0);
    });

    it('reports zeros on an empty queue', async () => {
      const res = await http.get('/metrics').expect(200);

      expect(res.body).toMatchObject({ pending: 0, sent: 0, queueLagSeconds: 0 });
    });
  });

  describe('GET /health', () => {
    it('reports the application and PostgreSQL up', async () => {
      const res = await http.get('/health').expect(200);

      expect(res.body).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
    });
  });

  describe('POST /webhooks/mock', () => {
    const event = {
      eventId: '0b7f6d2e-5c1a-4e8b-9f3d-2a6c8e0b4d17',
      jobId: '3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c',
      status: 'SENT',
      attemptCount: 1,
      timestamp: '2026-09-24T12:00:00.000Z',
    };

    it('accepts an event once and flags redeliveries as duplicates', async () => {
      const first = await http.post('/webhooks/mock').send(event).expect(200);
      const again = await http.post('/webhooks/mock').send(event).expect(200);

      expect(first.body).toEqual({ eventId: event.eventId, duplicate: false, receivedCount: 1 });
      expect(again.body).toEqual({ eventId: event.eventId, duplicate: true, receivedCount: 2 });
    });

    it('validates the event', async () => {
      const res = await http
        .post('/webhooks/mock')
        .send({ ...event, status: 'PENDING', eventId: 'nope' })
        .expect(400);

      const fields = (res.body.details as { field: string }[]).map((d) => d.field).sort();
      expect(fields).toEqual(['eventId', 'status']);
    });
  });

  describe('security headers', () => {
    it('sends hardening headers and hides the framework on API responses', async () => {
      const res = await http.get('/metrics').expect(200);

      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('gives the Swagger UI a policy that lets it load', async () => {
      const res = await http.get('/api/docs').expect(200);

      expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    });
  });

  describe('worker role', () => {
    it('answers only /health and /metrics', async () => {
      const worker = await createTestApp({
        env: { APP_ROLE: 'worker', WORKER_POLL_INTERVAL_MS: '60000' },
      });
      try {
        const workerHttp = request(worker.getHttpServer());
        await workerHttp.get('/health').expect(200);
        await workerHttp.get('/metrics').expect(200);
        const res = await workerHttp.post('/notifications').send({}).expect(404);
        expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
        expect(res.body.message).toMatch(/APP_ROLE=worker/);
        // Swagger mounts on Express directly, outside Nest's middleware: it
        // must not be registered on a worker at all.
        await workerHttp.get('/api/docs').expect(404);
        await workerHttp.get('/api/docs-json').expect(404);
      } finally {
        await worker.close();
      }
    });
  });

  describe('structured logs', () => {
    it('writes one request line with requestId, method, path, status and duration, and no payload', async () => {
      await http
        .post('/notifications')
        .set('X-Request-ID', 'log-test-1')
        .send({
          recipient: 'user@example.com',
          channel: 'EMAIL',
          payload: { subject: 'SECRET-SUBJECT', body: 'SECRET-BODY' },
          priority: 'HIGH',
          delaySeconds: 60,
          idempotencyKey: 'log-test-key',
        })
        .expect(201);

      const line = logs.lines.find((l) => l.requestId === 'log-test-1');
      expect(line).toMatchObject({
        level: 30,
        service: 'notify-queue',
        requestId: 'log-test-1',
        req: { method: 'POST', path: '/notifications' },
        res: { statusCode: 201 },
        responseTime: expect.any(Number),
      });
      expect(logs.text).not.toContain('SECRET');
      expect(logs.text).not.toContain('user@example.com');
    });

    it('logs client errors at warn with the same request ID the client received', async () => {
      const res = await http.get('/notifications/not-a-uuid').expect(400);

      const line = logs.lines.find((l) => l.requestId === res.headers['x-request-id']);
      expect(line).toMatchObject({ level: 40, res: { statusCode: 400 } });
    });

    it('does not log health probes', async () => {
      await http.get('/health').expect(200);

      expect(
        logs.lines.filter((l) => (l.req as { path?: string } | undefined)?.path === '/health'),
      ).toEqual([]);
    });
  });
});
