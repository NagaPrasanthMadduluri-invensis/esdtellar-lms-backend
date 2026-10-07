import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';

import { OrgOptionsModule } from '@/modules/org-options/org-options.module';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { SeatsModule } from '@/modules/seats/seats.module';

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
  imports: [
    ActivityModule,
    ReportsModule,
    RolesModule,
    SeatsModule,
    NotificationsModule,
    OrgOptionsModule,
    // For the welcome email's set-password link. Safe in this direction:
    // AuthModule does not import UsersModule, so there is no cycle.
    AuthModule,
  ],
  controllers: [UsersController, EmployeesController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
