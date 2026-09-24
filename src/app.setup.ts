import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { JSON_BODY_LIMIT, REQUEST_ID_HEADER } from './common/constants/app.constants.js';
import type { AppConfig } from './config/configuration.js';
import { AppRole } from './config/env.validation.js';

export const SWAGGER_PATH = 'api/docs';

/**
 * HTTP concerns that live on the application instance rather than in a
 * module. Shared by main.ts and the end-to-end tests. The app must be created
 * with `{ bodyParser: false }` so this limit replaces Nest's default parser.
 */
/**
 * Security headers (and no X-Powered-By). The API only ever returns JSON, so
 * its Content-Security-Policy allows nothing at all. The Swagger UI is an
 * HTML page with inline bootstrap code, so it gets a policy that permits
 * exactly that, from this origin only.
 */
const apiHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
});
const docsHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
});

export const configureApp = (app: NestExpressApplication): void => {
  app.use((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const headers = (req.url ?? '').startsWith(`/${SWAGGER_PATH}`) ? docsHeaders : apiHeaders;
    headers(req, res, next);
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // useProcessExit: after the shutdown hooks finish, exit through
  // process.exit(0) rather than re-raising the signal. pino writes
  // asynchronously and flushes on the 'exit' event, which a re-raised SIGTERM
  // skips, so the last log lines (including the worker's drain report) would
  // be lost under load. It also makes a clean shutdown exit 0 instead of 143.
  app.enableShutdownHooks([], { useProcessExit: true });

  // Swagger mounts straight onto Express, outside Nest's middleware, so the
  // worker-role route restriction cannot filter it; a worker simply does not
  // register it.
  const role = app.get<ConfigService<AppConfig, true>>(ConfigService).get('role', { infer: true });
  if (role === AppRole.Worker) {
    return;
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Notify Queue API')
      .setDescription('Distributed delayed notification delivery system')
      .setVersion('1.0')
      .addGlobalParameters({
        name: REQUEST_ID_HEADER,
        in: 'header',
        required: false,
        schema: { type: 'string' },
      })
      .build(),
  );
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
  });
};
