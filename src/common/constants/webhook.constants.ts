/** Stable per event; receivers dedupe on it because delivery is at-least-once. */
export const WEBHOOK_EVENT_ID_HEADER = 'X-Webhook-Event-Id';

/** Events one dispatcher claims per pass. */
export const WEBHOOK_BATCH_SIZE = 50;
