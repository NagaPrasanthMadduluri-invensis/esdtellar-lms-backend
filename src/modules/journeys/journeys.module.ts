import { Module } from '@nestjs/common';

import { BadgesModule } from '@/modules/badges/badges.module';
import { CertificatesModule } from '@/modules/certificates/certificates.module';
import { MediaModule } from '@/modules/media/media.module';

import { AdminJourneysController } from './admin-journeys.controller';
import { JourneyGateModule } from './journey-gate.module';
import { JourneysRepository } from './journeys.repository';
import { JourneysService } from './journeys.service';
import { LearnerJourneysController } from './learner-journeys.controller';

/**
 * JourneysService is exported so the learner lesson routes can call
 * `assertCourseUnlocked()` (spec §4.3) and the lesson/assessment/SCORM
 * completion triggers can call `onCourseProgress()` (spec §4.2) — both wired
 * up in a later change, by the agents that own those routes. The repository
 * stays private (§3.2).
 */
@Module({
  // Certificates and badges are what a finished journey pays out; the journey
  // owns the moment of completion, so it calls them rather than being polled.
  imports: [MediaModule, CertificatesModule, BadgesModule, JourneyGateModule],
  controllers: [AdminJourneysController, LearnerJourneysController],
  providers: [JourneysService, JourneysRepository],
  exports: [JourneysService],
})
export class JourneysModule {}
