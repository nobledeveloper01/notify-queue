import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import { NotificationJobRepository } from '../../src/notifications/repositories/notification-job.repository.js';
import { WebhookService } from '../../src/webhooks/webhook.service.js';
import { newJob } from '../support/job.factory.js';
import { createTestApp } from '../support/test-app.js';
import { createTestDataSource, truncateAll } from '../support/test-database.js';
import { DEAD_WEBHOOK_URL, startWebhookReceiver } from '../support/webhook-receiver.js';

interface EventRow {
  dispatch_attempts: number;
  delivered_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

describe('Webhook dispatch (HTTP + PostgreSQL)', () => {
  let dataSource: DataSource;
  let jobs: NotificationJobRepository;
  let app: INestApplication | undefined;
  let closeReceiver: (() => Promise<void>) | undefined;

  const startDispatcher = async (url: string, env: Record<string, string> = {}) => {
    app = await createTestApp({
      listen: false,
      env: {
        WEBHOOK_URL: url,
        WEBHOOK_TIMEOUT_MS: '1000',
        BASE_RETRY_DELAY_MS: '1',
        MAX_RETRY_DELAY_MS: '2',
        ...env,
      },
    });
    return app.get(WebhookService);
  };

  /** Drives a job to SENT through the repository, which writes the outbox event. */
  const sendJob = async () => {
    const { job } = await jobs.insertIfAbsent(newJob());
    const { claimToken } = await jobs.claimDueJobs('worker-a', 1);
    await jobs.markSent(job.id, claimToken);
    return job;
  };

  const eventFor = async (jobId: string): Promise<EventRow> => {
    const [row]: EventRow[] = await dataSource.query(
      'SELECT dispatch_attempts, delivered_at, failed_at, last_error FROM webhook_events WHERE job_id = $1',
      [jobId],
    );
    return row;
  };

  /** Retries become due within milliseconds; dispatch until nothing is left. */
  const dispatchUntilQuiet = async (webhooks: WebhookService, rounds = 30) => {
    for (let i = 0; i < rounds; i++) {
      const report = await webhooks.dispatchDue();
      if (report.retrying === 0 && report.delivered === 0 && report.givenUp === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const again = await webhooks.dispatchDue();
        if (again.retrying + again.delivered + again.givenUp === 0) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    jobs = new NotificationJobRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await closeReceiver?.();
    closeReceiver = undefined;
  });

  it('POSTs the status change with a stable event ID', async () => {
    const receiver = await startWebhookReceiver();
    closeReceiver = receiver.close;
    const webhooks = await startDispatcher(receiver.url);
    const job = await sendJob();

    const report = await webhooks.dispatchDue();

    expect(report).toEqual({ delivered: 1, retrying: 0, givenUp: 0 });
    expect(receiver.received).toHaveLength(1);
    const [{ headers, body }] = receiver.received;
    expect(body).toEqual({
      eventId: expect.any(String),
      jobId: job.id,
      status: 'SENT',
      attemptCount: 1,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(headers['x-webhook-event-id']).toBe(body.eventId);
    expect((await eventFor(job.id)).delivered_at).toBeInstanceOf(Date);
    expect(await webhooks.dispatchDue()).toEqual({ delivered: 0, retrying: 0, givenUp: 0 });
  });

  it('retries a failing endpoint with backoff, redelivering the same event ID', async () => {
    const receiver = await startWebhookReceiver((n) => (n <= 2 ? 503 : 200));
    closeReceiver = receiver.close;
    const webhooks = await startDispatcher(receiver.url);
    const job = await sendJob();

    await dispatchUntilQuiet(webhooks);

    expect(receiver.received).toHaveLength(3);
    expect(new Set(receiver.received.map((r) => r.body.eventId)).size).toBe(1);
    const event = await eventFor(job.id);
    expect(event.dispatch_attempts).toBe(3);
    expect(event.delivered_at).toBeInstanceOf(Date);
  });

  it('gives up after WEBHOOK_MAX_ATTEMPTS, and the job keeps its status', async () => {
    const webhooks = await startDispatcher(DEAD_WEBHOOK_URL, { WEBHOOK_MAX_ATTEMPTS: '3' });
    const job = await sendJob();

    await dispatchUntilQuiet(webhooks);

    const event = await eventFor(job.id);
    expect(event.dispatch_attempts).toBe(3);
    expect(event.failed_at).toBeInstanceOf(Date);
    expect(event.last_error).toBe('ECONNREFUSED');
    expect((await jobs.findById(job.id))?.status).toBe(JobStatus.Sent);
  });

  it('does not dispatch when WEBHOOK_URL is unset, but keeps the event for later', async () => {
    const webhooks = await startDispatcher('');
    const job = await sendJob();

    expect(webhooks.enabled).toBe(false);
    expect(await webhooks.dispatchDue()).toEqual({ delivered: 0, retrying: 0, givenUp: 0 });
    expect((await eventFor(job.id)).dispatch_attempts).toBe(0);
  });
});
