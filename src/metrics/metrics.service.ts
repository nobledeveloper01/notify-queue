import { Injectable } from '@nestjs/common';
import { JobStatus } from '../common/enums/job-status.enum.js';
import type { MetricsResponseDto } from './dto/metrics-response.dto.js';
import { MetricsRepository } from './metrics.repository.js';

@Injectable()
export class MetricsService {
  constructor(private readonly metrics: MetricsRepository) {}

  /** Every status is always present, as 0 when no job is in it. */
  async snapshot(): Promise<MetricsResponseDto> {
    const { jobsByStatus, queueLagSeconds, webhooks } = await this.metrics.collect();
    const count = (status: JobStatus): number => jobsByStatus[status] ?? 0;

    return {
      pending: count(JobStatus.Pending),
      processing: count(JobStatus.Processing),
      sent: count(JobStatus.Sent),
      failed: count(JobStatus.Failed),
      deadLettered: count(JobStatus.DeadLettered),
      cancelled: count(JobStatus.Cancelled),
      queueLagSeconds: Math.round(queueLagSeconds * 1000) / 1000,
      webhooks,
    };
  }
}
