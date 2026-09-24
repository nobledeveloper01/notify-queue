import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';
import { LOG_DESTINATION } from '../../src/common/logging/logging.tokens.js';
import { AppModule } from '../../src/app.module.js';
import { AppLogger } from '../../src/common/logging/app-logger.service.js';
import { configureApp } from '../../src/app.setup.js';
import { NOTIFICATION_PROVIDER } from '../../src/delivery/providers/notification-provider.interface.js';
import type { NotificationProvider } from '../../src/delivery/providers/notification-provider.interface.js';
import { testDatabaseConfig } from './test-database.js';

export interface TestAppOptions {
  /** Extra or overriding environment variables. */
  env?: Record<string, string>;
  /** Replaces the mock provider. */
  provider?: NotificationProvider;
  /** Listen on an ephemeral port (for HTTP tests). */
  listen?: boolean;
  /** Capture log lines (set LOG_LEVEL too; tests default to silent). */
  logDestination?: DestinationStream;
}

/**
 * The real AppModule (same pipes, filters, middleware, workers) pointed at
 * the test database. APP_ROLE defaults to `api`, so the worker loop stays off
 * and tests drive WorkerService.poll() themselves; pass APP_ROLE=worker to
 * exercise the scheduler. Call createTestDataSource() first: it applies
 * migrations, which the app itself never does.
 */
export const createTestApp = async ({
  env = {},
  provider,
  listen = true,
  logDestination,
}: TestAppOptions = {}): Promise<NestExpressApplication> => {
  const db = testDatabaseConfig();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ROLE: 'api',
    LOG_LEVEL: 'silent',
    WEBHOOK_URL: '',
    DATABASE_HOST: db.host,
    DATABASE_PORT: String(db.port),
    DATABASE_NAME: db.name,
    DATABASE_USER: db.user,
    DATABASE_PASSWORD: db.password,
    DATABASE_POOL_MAX: '10',
    WORKER_ID: '',
    WORKER_CONCURRENCY: '10',
    WORKER_BATCH_SIZE: '100',
    WORKER_POLL_INTERVAL_MS: '1000',
    MAX_RETRIES: '5',
    BASE_RETRY_DELAY_MS: '1000',
    MAX_RETRY_DELAY_MS: '60000',
    PROVIDER_TIMEOUT_MS: '10000',
    MOCK_FAILURE_RATE: '0',
    MOCK_LATENCY_MS: '0',
    ...env,
  });

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (provider) {
    builder = builder.overrideProvider(NOTIFICATION_PROVIDER).useValue(provider);
  }
  if (logDestination) {
    builder = builder.overrideProvider(LOG_DESTINATION).useValue(logDestination);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  if (logDestination) {
    app.useLogger(app.get(AppLogger));
  }
  configureApp(app);
  if (listen) {
    await app.listen(0);
  } else {
    await app.init();
  }
  return app;
};
