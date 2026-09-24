import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './controllers/notifications.controller.js';
import { NotificationJob } from './entities/notification-job.entity.js';
import { NotificationJobRepository } from './repositories/notification-job.repository.js';
import { NotificationsService } from './services/notifications.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationJob])],
  controllers: [NotificationsController],
  providers: [NotificationJobRepository, NotificationsService],
  exports: [NotificationJobRepository],
})
export class NotificationsModule {}
