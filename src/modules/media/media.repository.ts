import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { lessons } from '@/database/schema';

/** A lesson's media state, as the admin side needs it. */
export interface LessonMediaRow {
  id: number;
  title: string;
  course_id: number;
  content_type: string;
  video_key: string | null;
  caption_key: string | null;
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

  /** Lesson + owning course, or null when it does not exist / is archived. */
  async findLesson(lessonId: number): Promise<LessonMediaRow | null> {
    const rows = await this.db.all<LessonMediaRow>(sql`
      SELECT l.id, l.title, cm.course_id, l.content_type,
             l.video_key, l.caption_key
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.id = ${lessonId} AND l.is_active = 1 AND cm.is_active = 1
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
    lessonId: number,
    userId: number,
  ): Promise<LearnerLessonMediaRow | null> {
    const rows = await this.db.all<LearnerLessonMediaRow>(sql`
      SELECT l.id, l.title, cm.course_id, l.content_type,
             l.video_key, l.caption_key, l.is_preview,
             CASE WHEN EXISTS (
               SELECT 1 FROM user_course_assignments uca
               WHERE uca.user_id = ${userId} AND uca.course_id = cm.course_id
             ) THEN 1 ELSE 0 END AS assigned
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.id = ${lessonId} AND l.is_active = 1 AND cm.is_active = 1
    `);
    return rows[0] ?? null;
  }

  async setVideoKey(lessonId: number, key: string | null): Promise<void> {
    await this.db
      .update(lessons)
      .set({ videoKey: key })
      .where(eq(lessons.id, lessonId));
  }

  async setCaptionKey(lessonId: number, key: string | null): Promise<void> {
    await this.db
      .update(lessons)
      .set({ captionKey: key })
      .where(eq(lessons.id, lessonId));
  }
}
