import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { RetryModule } from '../retry/retry.module.js';
import { MockWebhookReceiverService } from './mock-webhook-receiver.service.js';
import { MockWebhookReceiptRepository } from './repositories/mock-webhook-receipt.repository.js';
import { WebhookEventRepository } from './repositories/webhook-event.repository.js';
import { WebhookService } from './webhook.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [HttpModule, RetryModule],
  controllers: [WebhooksController],
  providers: [
    WebhookService,
    WebhookEventRepository,
    MockWebhookReceiverService,
    MockWebhookReceiptRepository,
  ],
  exports: [WebhookService],
})
export class WebhooksModule {}
