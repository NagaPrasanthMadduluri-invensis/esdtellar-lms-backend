import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { ReportsModule } from '@/modules/reports/reports.module';
import { RolesModule } from '@/modules/roles/roles.module';

import { EmployeesController, UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * `RolesModule` is imported for `RolesService.roleByKey` — creating a learner
 * has to resolve the organization's `learner` role because `users.role_id` is
 * NOT NULL (`specs/rbac.md` §3.4). One-way edge: `RolesModule` does not import
 * this one.
 */
@Module({
  imports: [ActivityModule, ReportsModule, RolesModule],
  controllers: [UsersController, EmployeesController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
