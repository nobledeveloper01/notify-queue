import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RetryModule } from '../retry/retry.module.js';
import { JobClaimService } from './job-claim.service.js';
import { JobProcessorService } from './job-processor.service.js';
import { WorkerRecoveryService } from './worker-recovery.service.js';
import { WorkerScheduler } from './worker.scheduler.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [NotificationsModule, DeliveryModule, RetryModule],
  providers: [
    JobClaimService,
    JobProcessorService,
    WorkerService,
    WorkerRecoveryService,
    WorkerScheduler,
  ],
  exports: [WorkerService, WorkerRecoveryService],
})
export class WorkersModule {}
