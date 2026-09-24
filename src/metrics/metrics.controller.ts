import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MetricsResponseDto } from './dto/metrics-response.dto.js';
import { MetricsService } from './metrics.service.js';

@ApiTags('Operations')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiOperation({ summary: 'Queue depth by status, queue lag and webhook backlog' })
  @ApiOkResponse({ type: MetricsResponseDto })
  snapshot(): Promise<MetricsResponseDto> {
    return this.metricsService.snapshot();
  }
}
