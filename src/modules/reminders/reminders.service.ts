import { Injectable, Logger } from '@nestjs/common';

import { NotificationsService } from '@/modules/notifications/notifications.service';

import { RemindersRepository, type DueSoonRow } from './reminders.repository';

/**
 * `course_due_soon`, finally firing.
 *
 * The type has been in `common/notifications.ts` since 0030 with ZERO call
 * sites, because firing it needs something to run on a clock and this
 * codebase had no scheduler — the gap §10.12 and six other places record.
 * The email worker is that scheduler, so this is the first thing to use it.
 *
 * ## Why the reminder windows are discrete
 *
 * Seven days, three days, one day. Not "every day inside a week", which is
 * five emails about one course and is how somebody learns to filter the
 * sender. Each window fires at most once per course per learner, enforced
 * by reading what was already sent rather than by a flag:
 * `recentlyReminded` looks at the `notifications` rows the last run wrote.
 *
 * ## Why the dedupe is 2 days and not 1
 *
 * A run that happens at 08:59 and then 09:01 the next day is 24h 2m apart.
 * A one-day window would let both through and send the same reminder twice.
 */
const WINDOWS = [7, 3, 1];
const DEDUPE_DAYS = 2;

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly repository: RemindersRepository,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Runs daily from the worker. Never throws — a reminder sweep that fails
   * must not take the worker's other jobs down with it (§8.4).
   */
  async sendDueSoon(): Promise<{ sent: number; skipped: number }> {
    const result = { sent: 0, skipped: 0 };
    try {
      const rows = await this.repository.dueSoon(Math.max(...WINDOWS));
      if (rows.length === 0) return result;

      const already = await this.repository.recentlyReminded(DEDUPE_DAYS);

      for (const row of rows) {
        if (!WINDOWS.includes(row.days_left)) {
          result.skipped += 1;
          continue;
        }
        if (already.has(`${row.user_id}:${row.course_id}`)) {
          result.skipped += 1;
          continue;
        }

        /**
         * One notify() per (learner, course) rather than one per learner.
         *
         * It looks like the N+1 §7.1 forbids, and it is deliberately not
         * batched: `subject_id` has to be the COURSE for the dedupe above
         * to work, and a single row cannot carry three course ids. The
         * volume is bounded by how many assignments fall due on one
         * specific day across the platform, which is small — and this runs
         * once a day in a background process, not inside a request.
         */
        await this.notifications.notify({
          organizationId: row.organization_id,
          userIds: [row.user_id],
          type: 'course_due_soon',
          title: this.title(row),
          body: this.body(row),
          link: `/my-courses/${row.course_id}`,
          subjectType: 'course',
          subjectId: row.course_id,
        });
        result.sent += 1;
      }

      if (result.sent > 0) {
        this.logger.log(
          `Due-soon reminders: ${result.sent} sent, ${result.skipped} skipped.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Due-soon sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return result;
  }

  /**
   * The wording names the course and the deadline, because a notification
   * saying "a course is due soon" makes the reader open the app to find out
   * which — and the whole point of the reminder is that they might not.
   */
  private title(row: DueSoonRow): string {
    if (row.days_left === 0) return `"${row.course_name}" is due today`;
    if (row.days_left === 1) return `"${row.course_name}" is due tomorrow`;
    return `"${row.course_name}" is due in ${row.days_left} days`;
  }

  private body(row: DueSoonRow): string {
    const when = new Date(`${row.due_date}T00:00:00Z`).toLocaleDateString(
      'en-GB',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
    );
    return (
      `You have not finished this course yet and it is due on ${when}. ` +
      'Pick up where you left off — your progress is saved.'
    );
  }
}
