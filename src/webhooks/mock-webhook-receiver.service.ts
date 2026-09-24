import { Injectable, Logger } from '@nestjs/common';
import type { WebhookEventDto } from './dto/webhook-event.dto.js';
import type { WebhookReceiptDto } from './dto/webhook-receipt.dto.js';
import { MockWebhookReceiptRepository } from './repositories/mock-webhook-receipt.repository.js';

/**
 * A well-behaved receiver, for the demo: it acknowledges every delivery but
 * acts on each event ID once, which is what at-least-once delivery requires
 * of whoever is on the other end.
 */
@Injectable()
export class MockWebhookReceiverService {
  private readonly logger = new Logger(MockWebhookReceiverService.name);

  constructor(private readonly receipts: MockWebhookReceiptRepository) {}

  async receive(event: WebhookEventDto): Promise<WebhookReceiptDto> {
    const receivedCount = await this.receipts.record(event.eventId, event.jobId, event.status);
    const duplicate = receivedCount > 1;
    this.logger.log({
      event: duplicate ? 'webhook.duplicate_ignored' : 'webhook.received',
      eventId: event.eventId,
      jobId: event.jobId,
      status: event.status,
    });
    return { eventId: event.eventId, duplicate, receivedCount };
  }
}
