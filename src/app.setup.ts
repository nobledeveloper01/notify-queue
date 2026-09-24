import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JSON_BODY_LIMIT, REQUEST_ID_HEADER } from './common/constants/app.constants.js';

export const SWAGGER_PATH = 'api/docs';

/**
 * HTTP concerns that live on the application instance rather than in a
 * module. Shared by main.ts and the end-to-end tests. The app must be created
 * with `{ bodyParser: false }` so this limit replaces Nest's default parser.
 */
export const configureApp = (app: NestExpressApplication): void => {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // useProcessExit: after the shutdown hooks finish, exit through
  // process.exit(0) rather than re-raising the signal. pino writes
  // asynchronously and flushes on the 'exit' event, which a re-raised SIGTERM
  // skips, so the last log lines (including the worker's drain report) would
  // be lost under load. It also makes a clean shutdown exit 0 instead of 143.
  app.enableShutdownHooks([], { useProcessExit: true });

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
