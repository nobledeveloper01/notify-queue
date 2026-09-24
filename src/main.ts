import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/configuration.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);

  // SIGTERM/SIGINT run OnModuleDestroy/BeforeApplicationShutdown hooks, which
  // the worker relies on to stop claiming and drain in-flight jobs.
  app.enableShutdownHooks();

  const port = config.get('port', { infer: true });
  await app.listen(port);

  new Logger('Bootstrap').log(
    `Notify Queue started (role=${config.get('role', { infer: true })}, port=${port})`,
  );
};

await bootstrap();
