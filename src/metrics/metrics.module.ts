import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller.js';
import { MetricsRepository } from './metrics.repository.js';
import { MetricsService } from './metrics.service.js';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsRepository],
})
export class MetricsModule {}
