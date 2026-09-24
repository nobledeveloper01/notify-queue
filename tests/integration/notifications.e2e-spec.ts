import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';

const body = (overrides: Record<string, unknown> = {}) => ({
  recipient: 'user@example.com',
  channel: 'EMAIL',
  payload: { subject: 'Welcome', body: 'Welcome to Notify Queue' },
  priority: 'HIGH',
  delaySeconds: 60,
  idempotencyKey: 'welcome-user-123',
  ...overrides,
});

describe('Notifications API (HTTP + PostgreSQL)', () => {
  let dataSource: DataSource;
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    app = await createTestApp();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  describe('POST /notifications', () => {
    it('creates a job, persists it, and returns 201 with the job', async () => {
      const res = await http.post('/notifications').send(body()).expect(201);

      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body).toMatchObject({
        idempotencyKey: 'welcome-user-123',
        recipient: 'user@example.com',
        channel: 'EMAIL',
        priority: 'HIGH',
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 6,
      });
      expect(res.body).not.toHaveProperty('payload');

      const [row]: { payload: unknown; priority: number; request_fingerprint: string }[] =
        await dataSource.query(
          'SELECT payload, priority, request_fingerprint FROM notification_jobs WHERE id = $1',
          [res.body.id],
        );
      expect(row.payload).toEqual(body().payload);
      expect(row.priority).toBe(3);
      expect(row.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('schedules at an absolute time', async () => {
      const sendAt = '2026-12-01T09:30:00.000Z';

      const res = await http
        .post('/notifications')
        .send(body({ delaySeconds: undefined, sendAt }))
        .expect(201);

      expect(res.body.scheduledAt).toBe(sendAt);
      expect(res.body.nextAttemptAt).toBe(sendAt);
    });

    it('replays an identical request with 200 and the same job', async () => {
      const first = await http.post('/notifications').send(body()).expect(201);
      const replay = await http.post('/notifications').send(body()).expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(first.body.id);
      const [{ count }]: { count: string }[] = await dataSource.query(
        'SELECT count(*) FROM notification_jobs',
      );
      expect(count).toBe('1');
    });

    it('rejects a reused key with a different body with 409', async () => {
      await http.post('/notifications').send(body()).expect(201);

      const res = await http
        .post('/notifications')
        .send(body({ recipient: 'someone-else@example.com' }))
        .expect(409);

      expect(res.body).toMatchObject({ statusCode: 409, error: 'Conflict' });
      expect(res.body.message).toMatch(/already used for a different/);
    });

    it.each([
      ['neither sendAt nor delaySeconds', { delaySeconds: undefined }],
      ['both sendAt and delaySeconds', { sendAt: '2026-12-01T09:30:00Z' }],
    ])('rejects %s with a field error', async (_, overrides) => {
      const res = await http.post('/notifications').send(body(overrides)).expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        path: '/notifications',
      });
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          {
            field: 'sendAt',
            errors: expect.arrayContaining([expect.stringMatching(/exactly one/)]),
          },
        ]),
      );
    });

    it('rejects properties the API does not define', async () => {
      const res = await http
        .post('/notifications')
        .send(body({ status: 'SENT' }))
        .expect(400);

      expect(res.body.details).toEqual([
        { field: 'status', errors: ['property status should not exist'] },
      ]);
    });

    it('reports every invalid field at once', async () => {
      const res = await http
        .post('/notifications')
        .send(body({ channel: 'FAX', priority: 'URGENT', payload: 'text', delaySeconds: 0 }))
        .expect(400);

      const fields = (res.body.details as { field: string }[]).map((d) => d.field).sort();
      expect(fields).toEqual(['channel', 'delaySeconds', 'payload', 'priority']);
    });

    it('rejects a schedule more than a year ahead', async () => {
      await http
        .post('/notifications')
        .send(body({ delaySeconds: undefined, sendAt: '2099-01-01T00:00:00Z' }))
        .expect(400);
    });

    it('rejects malformed JSON with the standard error shape', async () => {
      const res = await http
        .post('/notifications')
        .set('Content-Type', 'application/json')
        .send('{"recipient":')
        .expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, requestId: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(/);
    });

    it('rejects a body over the size limit with 413', async () => {
      const res = await http
        .post('/notifications')
        .send(body({ payload: { body: 'x'.repeat(70 * 1024) } }))
        .expect(413);

      expect(res.body).toMatchObject({ statusCode: 413, requestId: expect.any(String) });
    });
  });

  describe('GET /notifications/:id', () => {
    it('returns the job', async () => {
      const created = await http.post('/notifications').send(body()).expect(201);

      const res = await http.get(`/notifications/${created.body.id}`).expect(200);

      expect(res.body).toEqual(created.body);
    });

    it('returns 404 for an unknown job', async () => {
      const res = await http.get('/notifications/3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c').expect(404);

      expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    });

    it('returns 400 for an ID that is not a UUID', async () => {
      await http.get('/notifications/not-a-uuid').expect(400);
    });
  });

  describe('request IDs', () => {
    it('echoes a caller-supplied request ID on success and in error bodies', async () => {
      const ok = await http
        .post('/notifications')
        .set('X-Request-ID', 'trace-abc.123')
        .send(body());
      const err = await http.get('/notifications/not-a-uuid').set('X-Request-ID', 'trace-def');

      expect(ok.headers['x-request-id']).toBe('trace-abc.123');
      expect(err.headers['x-request-id']).toBe('trace-def');
      expect(err.body.requestId).toBe('trace-def');
    });

    it('replaces an unsafe request ID with a generated one', async () => {
      const res = await http
        .get('/notifications/not-a-uuid')
        .set('X-Request-ID', 'bad id\twith spaces');

      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('Swagger', () => {
    it('documents the notification endpoints and their models', async () => {
      const res = await http.get('/api/docs-json').expect(200);

      expect(res.body.info).toMatchObject({ title: 'Notify Queue API', version: '1.0' });
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(['/notifications', '/notifications/{id}']),
      );
      expect(Object.keys(res.body.paths['/notifications'].post.responses).sort()).toEqual([
        '200',
        '201',
        '400',
        '409',
      ]);
      expect(Object.keys(res.body.components.schemas)).toEqual(
        expect.arrayContaining([
          'ScheduleNotificationDto',
          'NotificationResponseDto',
          'ErrorResponseDto',
        ]),
      );
    });

    it('serves the Swagger UI', async () => {
      await http.get('/api/docs').expect(200).expect('Content-Type', /html/);
    });
  });
});
