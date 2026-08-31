import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './common/guards/auth.guard';
import { PlatformAdminGuard } from './common/guards/platform-admin.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantContextGuard } from './common/guards/tenant-context.guard';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AssessmentsModule } from './modules/assessments/assessments.module';
import { AuthModule } from './modules/auth/auth.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { CoursesModule } from './modules/courses/courses.module';
import { LearnerModule } from './modules/learner/learner.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { LearningHoursModule } from './modules/learning-hours/learning-hours.module';
import { MediaModule } from './modules/media/media.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ScormModule } from './modules/scorm/scorm.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [configuration],
      validate: validateEnv,
      cache: true,
    }),
    DatabaseModule,
    AuthModule,
    OrganizationsModule,
    UsersModule,
    CoursesModule,
    AssessmentsModule,
    SessionsModule,
    CertificatesModule,
    LearnerModule,
    ScormModule,
    ReportsModule,
    MediaModule,
    LearningHoursModule,
    LeaderboardModule,
  ],
  providers: [
    // Order matters, and all four are global so a new controller is covered
    // the moment it is written:
    //   1. AuthGuard populates request.user from the verified JWT.
    //   2. RolesGuard reads it to enforce @Roles.
    //   3. PlatformAdminGuard enforces the finer @PlatformAdmin restriction,
    //      same shape as RolesGuard but checked against the platform org id.
    //   4. TenantContextGuard mints request.orgScope from request.user last,
    //      once every authorization decision above it has already passed.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PlatformAdminGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
  ],
})
export class AppModule {}
