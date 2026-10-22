import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { AdminDataRequestsController } from './admin-data-requests.controller';
import { MyDataController } from './my-data.controller';
import { MyDataRepository } from './my-data.repository';
import { MyDataService } from './my-data.service';

/**
 * "My Data" self-service (0056): PDPA Access, Portability, and the request side
 * of Correction and Deletion.
 *
 * Imports `NotificationsModule` so filing a request alerts the org's admins and
 * confirms to the subject (bell + transactional email). The catalogue gained
 * `data_request_received` / `data_request_submitted` for this, so a deploy needs
 * a worker restart (new catalogue types), but no schema change.
 */
// 0056 — My Data self-service.
@Module({
  imports: [NotificationsModule],
  controllers: [MyDataController, AdminDataRequestsController],
  providers: [MyDataService, MyDataRepository],
})
export class MyDataModule {}
