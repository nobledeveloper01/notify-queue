import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { RANDOM } from '../../common/tokens/random.token.js';
import type { RandomSource } from '../../common/tokens/random.token.js';
import type { DeliveryResult } from '../dto/delivery-result.dto.js';
import { MockDeliveryRepository } from '../repositories/mock-delivery.repository.js';
import type {
  NotificationProvider,
  SendNotificationInput,
} from './notification-provider.interface.js';

/** Recipients with this prefix are rejected permanently, to demonstrate FAILED. */
export const MOCK_REJECTED_RECIPIENT_PREFIX = 'invalid';

/**
 * Simulates an external provider:
 * - takes `MOCK_LATENCY_MS` per call;
 * - honours delivery keys: a key it has accepted before is acknowledged as a
 *   duplicate and not "sent" again, whichever worker asks;
 * - fails transiently with probability `MOCK_FAILURE_RATE`;
 * - rejects recipients starting with "invalid" permanently.
 */
@Injectable()
export class MockNotificationProvider implements NotificationProvider {
  private readonly failureRate: number;
  private readonly latencyMs: number;

  constructor(
    private readonly deliveries: MockDeliveryRepository,
    config: ConfigService<AppConfig, true>,
    @Inject(RANDOM) private readonly random: RandomSource,
  ) {
    const delivery = config.get('delivery', { infer: true });
    this.failureRate = delivery.mockFailureRate;
    this.latencyMs = delivery.mockLatencyMs;
  }

  async send(input: SendNotificationInput): Promise<DeliveryResult> {
    if (this.latencyMs > 0) {
      await sleep(this.latencyMs, undefined, { signal: input.signal });
    }

    const previous = await this.deliveries.findMessageId(input.deliveryKey);
    if (previous) {
      return { outcome: 'delivered', providerMessageId: previous, duplicate: true };
    }
    if (input.recipient.startsWith(MOCK_REJECTED_RECIPIENT_PREFIX)) {
      return { outcome: 'failed', retryable: false, error: 'Recipient rejected by provider' };
    }
    if (this.random() < this.failureRate) {
      return { outcome: 'failed', retryable: true, error: 'Simulated provider outage' };
    }

    const { messageId, created } = await this.deliveries.record(
      input.deliveryKey,
      input.recipient,
      input.channel,
    );
    return { outcome: 'delivered', providerMessageId: messageId, duplicate: !created };
  }
}
