import { ForbiddenException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/**
 * "May this learner open this course's content right now?"
 *
 * Its own tiny provider, deliberately, rather than a method on
 * `JourneysService`. Six different paths deliver course content — the lesson
 * read, the lesson-complete write, lesson media, video progress, resource
 * URLs, SCORM and assessments — and every one of them has to ask. Most live in
 * modules that `JourneysModule` itself depends on (MediaModule, for
 * thumbnails), so hanging the check off `JourneysService` would have forced a
 * `forwardRef` cycle through half the server. This has no dependencies but the
 * database, so anything may import it.
 *
 * **This is the enforcement, not the decoration.** Drawing a padlock in the UI
 * and checking nothing here leaves the next course exactly one URL away. Spec
 * §4.3 and BACKEND_STRUCTURE.md §10.11.
 */
@Injectable()
export class JourneyGateService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * A course is locked when BOTH hold:
   *
   *  - the learner's assignment for it exists only because a journey put it
   *    there (`source_journey_id IS NOT NULL`). A course an admin assigned
   *    directly is open, always — a course is never locked globally, only its
   *    position inside a journey is;
   *  - AND no journey the learner is enrolled on offers it yet. A learner on
   *    two journeys sharing a course, where one has it at step 1 and the other
   *    at step 5, may take it: the first path has genuinely opened it, and the
   *    assignment row can only record one journey as its source.
   *
   * One query. The gate sits in front of content delivery, so it cannot afford
   * a round trip per journey (§7.1).
   */
  async isLocked(scope: OrgScope, userId: number, courseId: number): Promise<boolean> {
    const rows = await this.db.all<{ locked: boolean }>(sql`
      SELECT (
        EXISTS (
          SELECT 1 FROM user_course_assignments a
          WHERE a.user_id = ${userId} AND a.course_id = ${courseId}
            AND a.source_journey_id IS NOT NULL
            AND ${orgScope('a', scope)}
        )
        AND NOT EXISTS (
          -- Any enrolled journey in which every required earlier step is done.
          SELECT 1
          FROM journey_enrollments je
          JOIN journey_courses jc
            ON jc.journey_id = je.journey_id AND jc.course_id = ${courseId}
          WHERE je.user_id = ${userId} AND ${orgScope('je', scope)}
            AND NOT EXISTS (
              SELECT 1 FROM journey_courses earlier
              WHERE earlier.journey_id = je.journey_id
                AND earlier.is_required = 1
                AND earlier.sort_order < jc.sort_order
                AND NOT ${this.courseComplete(sql`earlier.course_id`, sql`je.user_id`)}
            )
        )
      ) AS locked
    `);
    return Boolean(rows[0]?.locked);
  }

  /** Enforcement. 403 — the course exists and is theirs, it is just not open yet. */
  async assertUnlocked(scope: OrgScope, userId: number, courseId: number): Promise<void> {
    if (await this.isLocked(scope, userId, courseId)) {
      throw new ForbiddenException(
        'Complete the earlier required courses in this journey first.',
      );
    }
  }

  /**
   * The ONE definition of a complete course, matching
   * `CertificatesService.evaluate()`: every active lesson done, and any active
   * assessment passed. Written as an expression so the gate stays one query.
   */
  private courseComplete(courseIdExpr: ReturnType<typeof sql>, userIdExpr: ReturnType<typeof sql>) {
    return sql`(
      EXISTS (
        SELECT 1 FROM lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        WHERE cm.course_id = ${courseIdExpr} AND l.is_active = 1 AND cm.is_active = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        WHERE cm.course_id = ${courseIdExpr} AND l.is_active = 1 AND cm.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_lesson_completions ulc
            WHERE ulc.lesson_id = l.id AND ulc.user_id = ${userIdExpr}
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM assessments a
        WHERE a.course_id = ${courseIdExpr} AND a.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_assessment_attempts t
            WHERE t.assessment_id = a.id AND t.user_id = ${userIdExpr}
              AND t.is_passed = 1
          )
      )
    )`;
  }
}
