import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { DeliveryResult } from '../../src/delivery/dto/delivery-result.dto.js';
import type {
  NotificationProvider,
  SendNotificationInput,
} from '../../src/delivery/providers/notification-provider.interface.js';

/**
 * Deterministic providers for tests (never random). All of them record every
 * call and behave like a real idempotent provider: once a delivery key has
 * been accepted, later sends with that key are acknowledged as duplicates.
 * One instance shared by several workers models one shared external provider.
 */
export class RecordingProvider implements NotificationProvider {
  readonly calls: SendNotificationInput[] = [];
  private readonly accepted = new Map<string, string>();
  private readonly attemptsByKey = new Map<string, number>();
  private inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly latencyMs = 0) {}

  /** Distinct notifications that actually went out. */
  get logicalDeliveries(): number {
    return this.accepted.size;
  }

  async send(input: SendNotificationInput): Promise<DeliveryResult> {
    this.calls.push(input);
    const attempt = (this.attemptsByKey.get(input.deliveryKey) ?? 0) + 1;
    this.attemptsByKey.set(input.deliveryKey, attempt);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs > 0) await sleep(this.latencyMs, undefined, { signal: input.signal });

      const previous = this.accepted.get(input.deliveryKey);
      if (previous) return { outcome: 'delivered', providerMessageId: previous, duplicate: true };

      const failure = this.failureFor(attempt);
      if (failure) return failure;

      const messageId = randomUUID();
      this.accepted.set(input.deliveryKey, messageId);
      return { outcome: 'delivered', providerMessageId: messageId, duplicate: false };
    } finally {
      this.inFlight--;
    }
  }

  /** Subclasses decide which attempts fail; null means deliver. */
  protected failureFor(_attempt: number): DeliveryResult | null {
    return null;
  }
}

export class AlwaysSuccessProvider extends RecordingProvider {}

export class AlwaysFailProvider extends RecordingProvider {
  constructor(
    private readonly retryable = true,
    latencyMs = 0,
  ) {
    super(latencyMs);
  }

  protected override failureFor(): DeliveryResult {
    return {
      outcome: 'failed',
      retryable: this.retryable,
      error: this.retryable ? 'Provider unavailable' : 'Recipient rejected',
    };
  }
}

/** Fails the first `failures` attempts of each delivery key, then succeeds. */
export class FailNTimesProvider extends RecordingProvider {
  constructor(private readonly failures: number) {
    super();
  }

  protected override failureFor(attempt: number): DeliveryResult | null {
    return attempt <= this.failures
      ? { outcome: 'failed', retryable: true, error: `Transient failure ${attempt}` }
      : null;
  }
}

/** Ignores the abort signal and never answers: exercises the delivery timeout. */
export class HangingProvider implements NotificationProvider {
  send(): Promise<DeliveryResult> {
    return new Promise(() => undefined);
  }
}

/** Throws instead of returning a result: exercises error containment. */
export class ThrowingProvider implements NotificationProvider {
  send(): Promise<DeliveryResult> {
    return Promise.reject(new Error('socket hang up'));
  }
}
