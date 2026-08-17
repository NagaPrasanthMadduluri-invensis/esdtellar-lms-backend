import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AssessmentsModule } from './modules/assessments/assessments.module';
import { AuthModule } from './modules/auth/auth.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { CoursesModule } from './modules/courses/courses.module';
import { LearnerModule } from './modules/learner/learner.module';
import { MediaModule } from './modules/media/media.module';
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
    UsersModule,
    CoursesModule,
    AssessmentsModule,
    SessionsModule,
    CertificatesModule,
    LearnerModule,
    ScormModule,
    ReportsModule,
    MediaModule,
  ],
  providers: [
    // Order matters: AuthGuard populates request.user, RolesGuard reads it.
    // Both are global, so authentication is opt-OUT (@Public) rather than
    // opt-in — a new controller is protected the moment it is written.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
