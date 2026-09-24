import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggingModule } from './common/logging/logging.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware.js';
import { RoleRoutesMiddleware } from './common/middleware/role-routes.middleware.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { configuration } from './config/configuration.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkersModule } from './workers/workers.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
    }),
    LoggingModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    NotificationsModule,
    WorkersModule,
    WebhooksModule,
    MetricsModule,
    HealthModule,
  ],
  providers: [
    // Registered as providers (not in main.ts) so tests that build AppModule
    // get exactly the validation and error handling production gets.
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, RequestLoggingMiddleware, RoleRoutesMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
