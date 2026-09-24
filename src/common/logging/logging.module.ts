import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DestinationStream } from 'pino';
import type { AppConfig } from '../../config/configuration.js';
import { AppLogger } from './app-logger.service.js';
import { LOG_DESTINATION, PINO_LOGGER } from './logging.tokens.js';
import { createPinoLogger } from './pino.factory.js';

@Global()
@Module({
  providers: [
    { provide: LOG_DESTINATION, useValue: null },
    {
      provide: PINO_LOGGER,
      inject: [ConfigService, LOG_DESTINATION],
      useFactory: (config: ConfigService<AppConfig, true>, destination: DestinationStream | null) =>
        createPinoLogger(
          {
            nodeEnv: config.get('nodeEnv', { infer: true }),
            role: config.get('role', { infer: true }),
            logLevel: config.get('logLevel', { infer: true }),
          },
          destination ?? undefined,
        ),
    },
    AppLogger,
  ],
  exports: [PINO_LOGGER, AppLogger],
})
export class LoggingModule {}
