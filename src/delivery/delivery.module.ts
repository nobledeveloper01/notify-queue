import { Module } from '@nestjs/common';
import { RANDOM } from '../common/tokens/random.token.js';
import { DeliveryService } from './delivery.service.js';
import { MockNotificationProvider } from './providers/mock-notification.provider.js';
import { NOTIFICATION_PROVIDER } from './providers/notification-provider.interface.js';
import { MockDeliveryRepository } from './repositories/mock-delivery.repository.js';

@Module({
  providers: [
    DeliveryService,
    MockDeliveryRepository,
    { provide: RANDOM, useValue: Math.random },
    // Swap this binding to use a real provider; nothing else changes.
    { provide: NOTIFICATION_PROVIDER, useClass: MockNotificationProvider },
  ],
  exports: [DeliveryService],
})
export class DeliveryModule {}
