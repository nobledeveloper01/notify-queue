import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';
import { RecipientRateLimitRepository } from './repositories/recipient-rate-limit.repository.js';

@Module({
  providers: [RateLimitService, RecipientRateLimitRepository],
  exports: [RateLimitService],
})
export class RateLimitModule {}
