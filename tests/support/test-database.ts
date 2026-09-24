import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import type { DatabaseConfig } from '../../src/config/configuration.js';
import { buildDataSourceOptions } from '../../src/database/database.config.js';
import { NotificationJob } from '../../src/notifications/entities/notification-job.entity.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * Tests truncate tables, so they only ever connect to a database whose name
 * ends in `_test` (the compose init script creates `notify_queue_test`).
 */
export const testDatabaseConfig = (poolMax = 10): DatabaseConfig => {
  const name = process.env.TEST_DATABASE_NAME ?? 'notify_queue_test';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${name}": name must end in _test`);
  }
  return {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5434),
    name,
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'postgres',
    poolMax,
  };
};

/** A connected DataSource with every migration applied. */
export const createTestDataSource = async (poolMax = 10): Promise<DataSource> => {
  const dataSource = new DataSource({
    ...buildDataSourceOptions(testDatabaseConfig(poolMax)),
    entities: [NotificationJob],
  });
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'all' });
  return dataSource;
};

export const truncateAll = async (dataSource: DataSource): Promise<void> => {
  await dataSource.query(
    `TRUNCATE notification_jobs, mock_provider_deliveries, rate_limit_reservations,
              webhook_events, mock_webhook_receipts`,
  );
};
