import type { NotificationChannel } from '../../common/enums/notification-channel.enum.js';
import type { DeliveryResult } from '../dto/delivery-result.dto.js';

/** DI token for the active NotificationProvider implementation. */
export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');

export interface SendNotificationInput {
  /**
   * Stable across every attempt of one job (it is the job ID). A provider
   * that has already accepted this key must not send again: this is what
   * turns at-least-once *attempts* into one logical delivery.
   */
  deliveryKey: string;
  recipient: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  /** Aborted when the caller's timeout elapses. */
  signal: AbortSignal;
}

export interface NotificationProvider {
  send(input: SendNotificationInput): Promise<DeliveryResult>;
}
