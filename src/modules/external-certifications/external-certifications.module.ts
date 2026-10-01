import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { CertificateFileService } from './certificate-file.service';
import {
  AdminExternalCertificationsController,
  ExternalCertificationFileController,
  LearnerExternalCertificationsController,
  ManagerExternalCertificationsController,
} from './external-certifications.controller';
import { ExternalCertificationsRepository } from './external-certifications.repository';
import { ExternalCertificationsService } from './external-certifications.service';

/**
 * External certifications (0036): training done elsewhere, counted here
 * once a manager and an admin have both said it happened.
 *
 * Four controllers for four audiences (§2.2) — the learner who claims, the
 * manager who confirms, the admin who decides, and the file, which belongs
 * to whoever is entitled to it rather than to a role.
 *
 * It imports nothing but Activity and Notifications. What an approval
 * CREATES — a course, a module, a lesson, an assignment, a completion — it
 * writes directly, in one statement, rather than by reaching into
 * CoursesService: those rows are not a course anybody authored, and routing
 * them through the course editor would mean teaching it about a kind of
 * course it must otherwise refuse to touch.
 */
@Module({
  imports: [NotificationsModule, ActivityModule],
  controllers: [
    LearnerExternalCertificationsController,
    ManagerExternalCertificationsController,
    AdminExternalCertificationsController,
    ExternalCertificationFileController,
  ],
  providers: [
    ExternalCertificationsService,
    ExternalCertificationsRepository,
    CertificateFileService,
  ],
})
export class ExternalCertificationsModule {}
