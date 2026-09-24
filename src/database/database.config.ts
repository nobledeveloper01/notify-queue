import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import type { DatabaseConfig } from '../config/configuration.js';

/**
 * Connection options shared by the Nest application and the TypeORM CLI, so
 * migrations always run against exactly what the app connects to.
 *
 * `synchronize` is off everywhere: the schema, its constraints and its
 * indexes are owned by hand-written migrations.
 */
export const buildDataSourceOptions = (db: DatabaseConfig): DataSourceOptions => ({
  type: 'postgres',
  host: db.host,
  port: db.port,
  database: db.name,
  username: db.user,
  password: db.password,
  synchronize: false,
  migrationsRun: false,
  migrations: [join(import.meta.dirname, 'migrations', '*.js')],
  migrationsTableName: 'typeorm_migrations',
  extra: {
    max: db.poolMax,
  },
});
