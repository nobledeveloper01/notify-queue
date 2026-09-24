/**
 * What a provider reports for one send. Failures are values, not exceptions,
 * so "retry or give up" is an explicit decision the caller has to make.
 */
export type DeliveryResult =
  | {
      outcome: 'delivered';
      providerMessageId: string;
      /** True when the provider had already accepted this delivery key. */
      duplicate: boolean;
    }
  | {
      outcome: 'failed';
      /** False for failures retrying cannot fix (e.g. a rejected recipient). */
      retryable: boolean;
      error: string;
    };
