import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp, SWAGGER_PATH } from './app.setup.js';
import type { AppConfig } from './config/configuration.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);

  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const port = config.get('port', { infer: true });
  await app.listen(port);

  new Logger('Bootstrap').log(
    `Notify Queue started (role=${config.get('role', { infer: true })}, port=${port}, docs=/${SWAGGER_PATH})`,
  );
};

await bootstrap();
