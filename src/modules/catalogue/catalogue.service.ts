import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { CoursesService } from '@/modules/courses/courses.service';
import { SessionsService } from '@/modules/sessions/sessions.service';

import { CatalogueRepository } from './catalogue.repository';

/**
 * "What may I join?" — one read over two capabilities.
 *
 * The LIST lives here because it is its own question and neither Courses nor
 * Sessions can answer half of it. The WRITES do not: enrolling delegates to
 * `CoursesService.selfEnrol` and `SessionsService.selfEnrol`, because a
 * roster write is a session rule (it creates the companion training
 * assignment, §10.7) and an assignment is a course rule. The module, never
 * the repository (§3.2) — this service cannot reach past either of them into
 * their tables.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly repository: CatalogueRepository,
    private readonly courses: CoursesService,
    private readonly sessions: SessionsService,
  ) {}

  async list(scope: OrgScope, userId: number) {
    const [courses, sessions] = await Promise.all([
      this.repository.openCourses(scope, userId),
      this.repository.openSessions(scope, userId),
    ]);

    return {
      courses: courses.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        thumbnail_url: row.thumbnail_url,
        category: row.category,
        is_mandatory: row.is_mandatory === 1,
        tags: row.tags,
        lessons_count: row.lessons_count,
        duration_minutes: row.duration_minutes,
        enrolled_count: row.enrolled_count,
        is_enrolled: row.is_enrolled > 0,
      })),
      sessions: sessions.map((row) => {
        const seatsLeft = Math.max(0, row.capacity - row.roster_count);
        return {
          id: row.id,
          title: row.title,
          description: row.description,
          thumbnail_url: row.thumbnail_url,
          session_type: row.session_type,
          date: row.date,
          start_time: row.start_time,
          end_time: row.end_time,
          venue_url: row.venue_url,
          trainer: row.trainer,
          capacity: row.capacity,
          roster_count: row.roster_count,
          waitlist_count: row.waitlist_count,
          /**
           * Derived here and sent down, so the button and the meter cannot
           * disagree with each other or with what the write will actually do
           * — the browser recomputing "is it full" is a second definition of
           * full, and the API is the one that enforces it.
           */
          seats_left: seatsLeft,
          is_full: row.capacity > 0 && seatsLeft === 0,
          is_enrolled: row.is_enrolled > 0,
          is_waitlisted: row.is_waitlisted > 0,
          waitlist_position:
            row.is_waitlisted > 0 ? (row.waitlist_position ?? null) : null,
        };
      }),
    };
  }

  enrolCourse(scope: OrgScope, courseId: number, user: AuthenticatedUser) {
    return this.courses.selfEnrol(scope, courseId, user.userId);
  }

  enrolSession(scope: OrgScope, sessionId: number, user: AuthenticatedUser) {
    return this.sessions.selfEnrol(scope, sessionId, user.userId);
  }

  leaveSession(scope: OrgScope, sessionId: number, user: AuthenticatedUser) {
    return this.sessions.selfLeave(scope, sessionId, user.userId);
  }
}
