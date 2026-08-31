import { Injectable } from '@nestjs/common';

import { parseScormDuration } from '@/common/scorm-duration.util';
import type { OrgScope } from '@/database/org-scope';

import { lastMonth, thisMonth, weeks } from './periods';
import {
  LearningHoursRepository,
  type MinutesRow,
  type Week,
} from './learning-hours.repository';

/** Minutes a learner accumulated, per period. */
export interface LearnerMinutes {
  all: number;
  thisMonth: number;
  lastMonth: number;
  weeks: number[];
}

/**
 * The single source of truth for learning hours.
 *
 * Both portals read this. They used to compute hours independently — the
 * learner view summed lesson durations plus SCORM time, while the admin
 * analytics summed lesson durations only — so the same learner showed two
 * different totals depending on who was looking. Anything that needs hours goes
 * through here now, so there is one definition to be right or wrong.
 *
 * Two content types report their own time and one does not:
 *   - video  -> measured watch seconds (lesson_video_progress)
 *   - SCORM  -> total_time reported by the package
 *   - other  -> the admin-declared duration_minutes, on completion
 */
@Injectable()
export class LearningHoursService {
  constructor(private readonly repository: LearningHoursRepository) {}

  /**
   * Lesson-side minutes per learner — measured video plus declared durations,
   * SCORM deliberately excluded (it is counted from its own reported time).
   */
  async lessonMinutes(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<MinutesRow[]> {
    return this.repository.minutesByUser(scope, month, previousMonth, weekRanges);
  }

  /** SCORM minutes per learner, parsed from whichever format the package used. */
  async scormMinutes(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<Map<number, LearnerMinutes>> {
    const rows = await this.repository.scormTimes(scope);
    const buckets = new Map<number, LearnerMinutes>();

    for (const row of rows) {
      const minutes = parseScormDuration(row.total_time);
      if (minutes === 0) continue;

      const key = Number(row.user_id);
      const entry = buckets.get(key) ?? LearningHoursService.empty();
      entry.all += minutes;

      const stamp = row.updated_at || '';
      const stampMonth = stamp.slice(0, 7);
      if (stampMonth === month) entry.thisMonth += minutes;
      if (stampMonth === previousMonth) entry.lastMonth += minutes;

      const day = stamp.slice(0, 10);
      weekRanges.forEach((week, index) => {
        if (day >= week.start && day <= week.end) entry.weeks[index] += minutes;
      });

      buckets.set(key, entry);
    }
    return buckets;
  }

  /**
   * Everything combined, per learner. This is what a caller wants unless it
   * needs the two halves separately.
   */
  async minutesByUser(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<Map<number, LearnerMinutes>> {
    const [lessonRows, scorm] = await Promise.all([
      this.lessonMinutes(scope, month, previousMonth, weekRanges),
      this.scormMinutes(scope, month, previousMonth, weekRanges),
    ]);

    const totals = new Map<number, LearnerMinutes>();
    for (const row of lessonRows) {
      totals.set(Number(row.user_id), {
        all: Number(row.all_time),
        thisMonth: Number(row.this_month),
        lastMonth: Number(row.last_month),
        weeks: [Number(row.w1), Number(row.w2), Number(row.w3), Number(row.w4)],
      });
    }

    for (const [userId, entry] of scorm) {
      const existing = totals.get(userId) ?? LearningHoursService.empty();
      existing.all += entry.all;
      existing.thisMonth += entry.thisMonth;
      existing.lastMonth += entry.lastMonth;
      entry.weeks.forEach((m, i) => { existing.weeks[i] += m; });
      totals.set(userId, existing);
    }

    return totals;
  }

  /**
   * All-time minutes per learner PER COURSE, keyed `userId:courseId`.
   *
   * What the exported report needs for its "Time Spent" column, which was a
   * literal em dash on every row before this existed. Reads the same two
   * halves as `minutesByUser` and combines them the same way, so a learner's
   * course rows add up to the total shown everywhere else.
   */
  async minutesByUserAndCourse(scope: OrgScope): Promise<Map<string, number>> {
    const [lessonRows, scormRows] = await Promise.all([
      this.repository.lessonMinutesByCourse(scope),
      this.repository.scormTimesByCourse(scope),
    ]);

    const totals = new Map<string, number>();
    const add = (userId: number, courseId: number, minutes: number) => {
      if (!minutes) return;
      const key = `${userId}:${courseId}`;
      totals.set(key, (totals.get(key) ?? 0) + minutes);
    };

    for (const row of lessonRows) {
      add(Number(row.user_id), Number(row.course_id), Number(row.minutes));
    }
    for (const row of scormRows) {
      // Parsed here rather than in SQL for the same reason as everywhere else:
      // the two SCORM versions use formats Postgres cannot sum.
      add(
        Number(row.user_id),
        Number(row.course_id),
        parseScormDuration(row.total_time),
      );
    }

    return totals;
  }

  /** Zero-filled entry, so callers never branch on "this learner has none". */
  static empty(): LearnerMinutes {
    return { all: 0, thisMonth: 0, lastMonth: 0, weeks: [0, 0, 0, 0] };
  }
}

export type { MinutesRow, Week };
