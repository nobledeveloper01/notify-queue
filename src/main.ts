import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppLogger } from './common/logging/app-logger.service.js';
import { AppModule } from './app.module.js';
import { configureApp, SWAGGER_PATH } from './app.setup.js';
import type { AppConfig } from './config/configuration.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  // Route Nest's own logs (and every `new Logger(...)` in services) through pino.
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  configureApp(app);

  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const port = config.get('port', { infer: true });
  await app.listen(port);

  logger.log(
    {
      event: 'app.started',
      role: config.get('role', { infer: true }),
      port,
      docs: `/${SWAGGER_PATH}`,
    },
    'Bootstrap',
  );
};

await bootstrap();
