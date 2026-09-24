import { Module } from '@nestjs/common';
import { RANDOM } from '../common/tokens/random.token.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RetryPolicyService } from './retry-policy.service.js';
import { RetryService } from './retry.service.js';

@Module({
  imports: [NotificationsModule],
  providers: [RetryPolicyService, RetryService, { provide: RANDOM, useValue: Math.random }],
  exports: [RetryService, RetryPolicyService],
})
export class RetryModule {}
