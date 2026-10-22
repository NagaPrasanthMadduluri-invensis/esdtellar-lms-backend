import { Module } from '@nestjs/common';

import { AdminDataRequestsController } from './admin-data-requests.controller';
import { MyDataController } from './my-data.controller';
import { MyDataRepository } from './my-data.repository';
import { MyDataService } from './my-data.service';

/**
 * "My Data" self-service (0056): PDPA Access, Portability, and the request side
 * of Correction and Deletion.
 *
 * Dependency-free beyond the global DatabaseModule — it only reads the subject's
 * own rows and writes `data_requests`. No EmailModule / NotificationsModule yet:
 * alerting admins to a new request needs a catalogue entry and a worker restart,
 * which is a deliberate follow-up rather than part of this self-contained slice.
 */
// 0056 — My Data self-service.
@Module({
  controllers: [MyDataController, AdminDataRequestsController],
  providers: [MyDataService, MyDataRepository],
})
export class MyDataModule {}
