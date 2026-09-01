import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import { lessons } from '@/database/schema';

/** A lesson's media state, as the admin side needs it. */
export interface LessonMediaRow {
  id: number;
  title: string;
  course_id: number;
  content_type: string;
  video_key: string | null;
  caption_key: string | null;
  video_duration_seconds: number | null;
  document_key: string | null;
  document_name: string | null;
  document_mime: string | null;
  document_size_bytes: number | null;
}

/** The same, plus whether this learner may watch it. */
export interface LearnerLessonMediaRow extends LessonMediaRow {
  /** 1 when the learner is assigned the course, else 0. */
  assigned: number;
  /** 1 when the lesson is marked as a free preview. */
  is_preview: number;
}

@Injectable()
export class MediaRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * `scope` is first on every method here (and across the sibling modules):
   * it is required, security-relevant, reads like a context argument, and
   * can never collide with an optional or defaulted parameter that follows.
   */

  /** Lesson + owning course, or null when it does not exist / is archived. */
  async findLesson(
    scope: OrgScope,
    lessonId: number,
  ): Promise<LessonMediaRow | null> {
    const rows = await this.db.all<LessonMediaRow>(sql`
      SELECT l.id, l.title, cm.course_id, l.content_type,
             l.video_key, l.caption_key, l.video_duration_seconds,
             l.document_key, l.document_name, l.document_mime,
             l.document_size_bytes
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.id = ${lessonId} AND l.is_active = 1 AND cm.is_active = 1
        AND ${contentScope('l', scope)}
    `);
    return rows[0] ?? null;
  }

  /**
   * A resource plus whether this learner may have it, in ONE round trip.
   *
   * Entitlement is the lesson's, not the resource's: a resource is reachable
   * exactly when its lesson is. The EXISTS subquery is the same shape
   * `findLessonForLearner` uses, for the same reason — authorising a download
   * must not cost a second query (§7.1).
   */
  async findResourceForLearner(
    scope: OrgScope,
    resourceId: number,
    userId: number,
  ) {
    const rows = await this.db.all<{
      id: number;
      lesson_id: number;
      title: string;
      source: string;
      file_key: string | null;
      file_name: string | null;
      mime_type: string | null;
      url: string | null;
      is_preview: number;
      assigned: number;
    }>(sql`
      SELECT r.id, r.lesson_id, r.title, r.source, r.file_key, r.file_name,
             r.mime_type, r.url, l.is_preview,
             (SELECT COUNT(*) FROM user_course_assignments uca
              WHERE uca.user_id = ${userId}
                AND uca.course_id = cm.course_id) AS assigned
      FROM lesson_resources r
      JOIN lessons l ON l.id = r.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE r.id = ${resourceId} AND l.is_active = 1 AND cm.is_active = 1
        AND ${contentScope('r', scope)}
    `);
    return rows[0] ?? null;
  }

  /**
   * Lesson media plus this learner's entitlement, in one round trip.
   *
   * The assignment test is an EXISTS subquery rather than a second query so
   * that authorising a playback URL never costs more than one hit (§7.1). The
   * service decides what `assigned = 0` means — it is not the repository's job
   * to turn that into a 403.
   */
  async findLessonForLearner(
    scope: OrgScope,
    lessonId: number,
    userId: number,
  ): Promise<LearnerLessonMediaRow | null> {
    const rows = await this.db.all<LearnerLessonMediaRow>(sql`
      SELECT l.id, l.title, cm.course_id, l.content_type,
             l.video_key, l.caption_key, l.video_duration_seconds, l.is_preview,
             CASE WHEN EXISTS (
               SELECT 1 FROM user_course_assignments uca
               WHERE uca.user_id = ${userId} AND uca.course_id = cm.course_id
             ) THEN 1 ELSE 0 END AS assigned
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.id = ${lessonId} AND l.is_active = 1 AND cm.is_active = 1
        AND ${contentScope('l', scope)}
    `);
    return rows[0] ?? null;
  }

  /**
   * Records watch progress.
   *
   * `watched_seconds` is raised with GREATEST and never lowered, so replaying a
   * video, a late-arriving request, or a duplicate retry can only ever confirm
   * time already earned. `last_position_seconds` is free to move backwards
   * because it is a bookmark, not a measurement.
   *
   * `lesson_video_progress` is an activity table — the row takes the watching
   * learner's org (§3.3).
   */
  async upsertVideoProgress(
    scope: OrgScope,
    values: {
      userId: number;
      lessonId: number;
      watchedSeconds: number;
      positionSeconds: number;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO lesson_video_progress
        (organization_id, user_id, lesson_id, watched_seconds,
         last_position_seconds, updated_at)
      VALUES (${scope.organizationId}, ${values.userId}, ${values.lessonId},
              ${values.watchedSeconds}, ${values.positionSeconds}, now())
      ON CONFLICT (user_id, lesson_id) DO UPDATE SET
        watched_seconds       = GREATEST(lesson_video_progress.watched_seconds,
                                         excluded.watched_seconds),
        last_position_seconds = excluded.last_position_seconds,
        updated_at            = now()
    `);
  }

  async findVideoProgress(scope: OrgScope, userId: number, lessonId: number) {
    const rows = await this.db.all<{
      watched_seconds: number;
      last_position_seconds: number;
    }>(sql`
      SELECT watched_seconds, last_position_seconds
      FROM lesson_video_progress
      WHERE user_id = ${userId} AND lesson_id = ${lessonId}
        AND ${orgScope('lesson_video_progress', scope)}
    `);
    return rows[0] ?? null;
  }

  /** Real duration of the uploaded file, captured at upload time. */
  async setVideoDuration(
    scope: OrgScope,
    lessonId: number,
    seconds: number | null,
  ): Promise<void> {
    await this.db
      .update(lessons)
      .set({ videoDurationSeconds: seconds })
      .where(
        and(eq(lessons.id, lessonId), eq(lessons.organizationId, scope.organizationId)),
      );
  }

  async setVideoKey(
    scope: OrgScope,
    lessonId: number,
    key: string | null,
  ): Promise<void> {
    await this.db
      .update(lessons)
      .set({ videoKey: key })
      .where(
        and(eq(lessons.id, lessonId), eq(lessons.organizationId, scope.organizationId)),
      );
  }

  async setCaptionKey(
    scope: OrgScope,
    lessonId: number,
    key: string | null,
  ): Promise<void> {
    await this.db
      .update(lessons)
      .set({ captionKey: key })
      .where(
        and(eq(lessons.id, lessonId), eq(lessons.organizationId, scope.organizationId)),
      );
  }
}
