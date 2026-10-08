import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/**
 * The Course Catalogue read: what a learner may add to their own learning.
 *
 * Two queries, never two per row (§7.1) — one for the open courses and one
 * for the open sessions, each already carrying this learner's own state so
 * the page does not have to ask a second time whether they are in.
 *
 * Raw SQL, snake_case rows throughout (§10.10).
 *
 * THE SCOPE SPLIT IS THE THING TO GET RIGHT HERE, and it is §10.12's rule:
 *
 *   - a COURSE is content, so `contentScope` — a course Edstellar publishes
 *     to every tenant is one this learner may genuinely join;
 *   - the ENROLMENT counted against it is activity, so every subquery over
 *     `user_course_assignments` carries its own `orgScope`. Without that, a
 *     shared course would show this tenant a headcount made of another
 *     tenant's learners;
 *   - a SESSION is org-owned, so `orgScope` is the whole predicate — there
 *     is no platform-owned session to widen to (§10.15).
 */

export interface CatalogueCourseRow {
  id: number;
  public_id: string | null;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  category: string | null;
  is_mandatory: number;
  tags: string | null;
  lessons_count: number;
  duration_minutes: number;
  enrolled_count: number;
  /** 1 when this learner already holds it, by any route. */
  is_enrolled: number;
}

export interface CatalogueSessionRow {
  id: number;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  session_type: string;
  date: string;
  start_time: string;
  end_time: string;
  venue_url: string;
  trainer: string;
  capacity: number;
  status: string;
  roster_count: number;
  waitlist_count: number;
  /** This learner's own state: on the roster, in the queue, or neither. */
  is_enrolled: number;
  is_waitlisted: number;
  /** Null when this learner is not queuing. */
  waitlist_position: number | null;
}

@Injectable()
export class CatalogueRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Published, non-archived, self-enrol courses this learner can see.
   *
   * `c.session_id IS NULL
         AND c.external_certification_id IS NULL` excludes a session's companion training: it is
   * reached by booking the session, and offering it here would enrol somebody
   * in a training with no sitting behind it (§10.7). The sessions half of the
   * catalogue is the right way in.
   */
  async openCourses(
    scope: OrgScope,
    userId: number,
  ): Promise<CatalogueCourseRow[]> {
    return this.db.all<CatalogueCourseRow>(sql`
      SELECT c.id,
             c.public_id,
             c.name,
             c.description,
             c.thumbnail_url,
             c.category,
             c.is_mandatory,
             c.tags,
             (SELECT COUNT(*)::int FROM lessons l
               JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = c.id AND l.is_active = 1 AND cm.is_active = 1
             ) AS lessons_count,
             (SELECT COALESCE(SUM(l.duration_minutes), 0)::int FROM lessons l
               JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = c.id AND l.is_active = 1 AND cm.is_active = 1
             ) AS duration_minutes,
             -- ACTIVITY against shared CONTENT, so its own orgScope (§10.12).
             (SELECT COUNT(*)::int FROM user_course_assignments uca
               WHERE uca.course_id = c.id AND ${orgScope('uca', scope)}
             ) AS enrolled_count,
             (SELECT COUNT(*)::int FROM user_course_assignments mine
               WHERE mine.course_id = c.id AND mine.user_id = ${userId}
             ) AS is_enrolled
        FROM courses c
       WHERE c.self_enrol = 1
         AND c.is_active = 1
         AND c.archived_at IS NULL
         AND c.session_id IS NULL
         AND c.external_certification_id IS NULL
         AND c.organization_id IN (${scope.organizationId}, ${scope.platformOrganizationId})
       ORDER BY c.name
    `);
  }

  /**
   * Self-enrol sessions still worth booking: not completed, not cancelled,
   * not archived.
   *
   * A session past its start time but not yet marked completed is still
   * listed — `display_status` calls that `in_progress` (§10.7) and a learner
   * joining a sitting that has begun is a real thing, so filtering on the
   * clock here would contradict the rest of the product.
   */
  async openSessions(
    scope: OrgScope,
    userId: number,
  ): Promise<CatalogueSessionRow[]> {
    return this.db.all<CatalogueSessionRow>(sql`
      SELECT s.id,
             s.title,
             s.description,
             tc.thumbnail_url,
             s.session_type,
             s.date,
             s.start_time,
             s.end_time,
             s.venue_url,
             s.trainer,
             s.capacity,
             s.status,
             (SELECT COUNT(*)::int FROM session_roster sr
               WHERE sr.session_id = s.id) AS roster_count,
             (SELECT COUNT(*)::int FROM session_waitlist w
               WHERE w.session_id = s.id) AS waitlist_count,
             (SELECT COUNT(*)::int FROM session_roster mine
               WHERE mine.session_id = s.id AND mine.user_id = ${userId}
             ) AS is_enrolled,
             (SELECT COUNT(*)::int FROM session_waitlist mq
               WHERE mq.session_id = s.id AND mq.user_id = ${userId}
             ) AS is_waitlisted,
             -- Where they stand in the queue, by arrival. Sent with the list
             -- rather than only in the enrol response, or a refresh would
             -- lose it and the page could only say "you are waiting".
             (SELECT COUNT(*)::int + 1 FROM session_waitlist earlier
               WHERE earlier.session_id = s.id
                 AND earlier.created_at < (
                   SELECT me.created_at FROM session_waitlist me
                    WHERE me.session_id = s.id AND me.user_id = ${userId}
                 )
             ) AS waitlist_position
        FROM sessions s
        -- The companion training carries the picture (§10.10): a session has
        -- no thumbnail column of its own, and the card here is the same card
        -- My Sessions shows.
   LEFT JOIN courses tc ON tc.session_id = s.id
       WHERE s.enroll_mode = 'self'
         AND s.status NOT IN ('completed', 'cancelled')
         AND s.archived_at IS NULL
         AND ${orgScope('s', scope)}
       ORDER BY s.date, s.start_time
    `);
  }
}
