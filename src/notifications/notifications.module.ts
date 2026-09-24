import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationJob } from './entities/notification-job.entity.js';
import { NotificationJobRepository } from './repositories/notification-job.repository.js';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationJob])],
  providers: [NotificationJobRepository],
  exports: [NotificationJobRepository],
})
export class NotificationsModule {}
