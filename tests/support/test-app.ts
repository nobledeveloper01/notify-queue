import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { testDatabaseConfig } from './test-database.js';

/**
 * The real AppModule (same pipes, filters, middleware) pointed at the test
 * database and listening on an ephemeral port, so concurrent supertest
 * requests share one server. Call createTestDataSource() first: it applies
 * migrations, which the app itself never does.
 */
export const createTestApp = async (): Promise<NestExpressApplication> => {
  const db = testDatabaseConfig();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_HOST: db.host,
    DATABASE_PORT: String(db.port),
    DATABASE_NAME: db.name,
    DATABASE_USER: db.user,
    DATABASE_PASSWORD: db.password,
    MAX_RETRIES: '5',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  await app.listen(0);
  return app;
};
