import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import type { HealthCheckResult } from '@nestjs/terminus';

@ApiTags('Operations')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
  ) {}

  /**
   * 200 when the process is serving and PostgreSQL answers within 1.5s;
   * 503 otherwise. Suitable for a container healthcheck or load balancer.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness of the application and its PostgreSQL connection' })
  @ApiServiceUnavailableResponse({ description: 'PostgreSQL is unreachable.' })
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.database.pingCheck('database').withTimeout(1500)]);
  }
}
