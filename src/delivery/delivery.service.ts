import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/utils/error.util.js';
import type { AppConfig } from '../config/configuration.js';
import type { NotificationJob } from '../notifications/entities/notification-job.entity.js';
import type { DeliveryResult } from './dto/delivery-result.dto.js';
import { NOTIFICATION_PROVIDER } from './providers/notification-provider.interface.js';
import type { NotificationProvider } from './providers/notification-provider.interface.js';

/**
 * The worker's only way to reach a provider. It fixes the delivery key to the
 * job ID, bounds every call with a timeout shorter than the job lease, and
 * turns anything a provider throws into a retryable failure, so a misbehaving
 * provider can never crash the worker or hang a job past its lease.
 */
@Injectable()
export class DeliveryService {
  private readonly timeoutMs: number;

  constructor(
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
    config: ConfigService<AppConfig, true>,
  ) {
    this.timeoutMs = config.get('delivery', { infer: true }).providerTimeoutMs;
  }

  async deliver(job: NotificationJob): Promise<DeliveryResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<DeliveryResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          outcome: 'failed',
          retryable: true,
          error: `Provider timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);
    });

    const sent = this.provider
      .send({
        deliveryKey: job.id,
        recipient: job.recipient,
        channel: job.channel,
        payload: job.payload,
        signal: controller.signal,
      })
      .catch((error: unknown): DeliveryResult => ({
        outcome: 'failed',
        retryable: true,
        error: errorMessage(error, 'Provider call failed'),
      }));

    try {
      // Whichever settles first wins. A provider that ignores the abort signal
      // may still complete later; the stable delivery key makes that harmless.
      return await Promise.race([sent, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
