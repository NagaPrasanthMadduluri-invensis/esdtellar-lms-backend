import { Module } from '@nestjs/common';

import { ReportsModule } from '@/modules/reports/reports.module';

import { EmployeesController, UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [ReportsModule],
  controllers: [UsersController, EmployeesController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
