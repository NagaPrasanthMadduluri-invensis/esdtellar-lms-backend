import { Injectable, Logger } from '@nestjs/common';

import { EmailOutboxService } from '@/modules/email/email-outbox.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

/** How far back a sweep looks. Two days covers a weekend outage. */
const WINDOW_HOURS = 48;

/**
 * Tells each organization's admins when an email to one of their people
 * gave up.
 *
 * ## Why this is a SWEEP and not a line in the drain job
 *
 * The obvious place is `OutboxDrainJob.handleFailure`, right where
 * `markFailed` is called. It cannot go there: `NotificationsModule` imports
 * `EmailModule` — that is what gave `notify()` its second channel (§10.30) —
 * so `EmailModule` importing notifications back is a cycle. `forwardRef`
 * would compile and would also make the two modules permanently
 * inseparable for a feature that does not need them to be.
 *
 * `RemindersModule` already imports notifications, already exists for
 * exactly this (work on a clock, no controller, worker-only), and importing
 * `EmailModule` here keeps the graph a DAG:
 *
 *     Worker -> Reminders -> { Notifications, Email }
 *               Notifications -> Email
 *
 * ## Why the bell and never an email
 *
 * `email_delivery_failed` is `email: 'none'` in the catalogue, and that is
 * the loop guard rather than a preference. This fires precisely when
 * sending is broken; if the cause is the transport rather than one bad
 * address, emailing the alert enqueues a message through the machinery that
 * has just failed — which fails, and alerts, and enqueues. An outbox that
 * fills itself is a worse failure than the one it is reporting.
 *
 * ## Dedupe
 *
 * `notifyOnce()` keyed on the OUTBOX ROW ID, the shape §10.18 prescribes
 * for anything recomputed rather than discrete. The sweep is free to run
 * every hour and re-read the same window; the same failure cannot ring a
 * bell twice, and nothing had to be remembered in a new column.
 */
@Injectable()
export class EmailFailureAlertsService {
  private readonly logger = new Logger(EmailFailureAlertsService.name);

  constructor(
    private readonly outbox: EmailOutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async sweep(): Promise<{ failures: number; organizations: number }> {
    const failures = await this.outbox.recentFailures(WINDOW_HOURS);
    if (failures.length === 0) return { failures: 0, organizations: 0 };

    /*
     * Grouped by organization so the admin list is resolved ONCE per
     * tenant rather than once per failed message (§7.1). A transport
     * outage produces hundreds of failures across a handful of orgs, and
     * `adminsOf` is a query.
     */
    const byOrg = new Map<number, typeof failures>();
    for (const row of failures) {
      if (!row.organization_id) continue;
      const list = byOrg.get(row.organization_id) ?? [];
      list.push(row);
      byOrg.set(row.organization_id, list);
    }

    for (const [organizationId, rows] of byOrg) {
      const admins = await this.notifications.adminsOf(organizationId);
      if (admins.length === 0) continue;

      for (const row of rows) {
        const who = row.to_name?.trim() || row.to_email;
        await this.notifications.notifyOnce({
          userIds: admins,
          organizationId,
          type: 'email_delivery_failed',
          /*
           * The recipient and the reason are IN the notification, not
           * behind a click. "An email failed" tells an admin to go and
           * look; "we could not reach priya@… — mailbox does not exist"
           * tells them what to do, and the two have different next steps.
           */
          title: `Could not email ${who}`,
          body:
            `"${row.subject}" gave up after ${row.attempts} attempt`
            + `${row.attempts === 1 ? '' : 's'}.`
            + (row.last_error ? ` Reason: ${row.last_error.slice(0, 200)}` : ''),
          link: '/admin/email',
          subjectType: 'email_outbox',
          subjectId: row.id,
          facts: [
            { label: 'Recipient', value: row.to_email },
            { label: 'Message', value: row.subject },
            { label: 'Attempts', value: String(row.attempts) },
            ...(row.last_error
              ? [{ label: 'Reason', value: row.last_error.slice(0, 200) }]
              : []),
          ],
          /*
           * Belt and braces with the catalogue's `email: 'none'`. The
           * policy is what actually decides; this says the intent at the
           * call site too, so somebody changing the catalogue entry meets
           * the question here rather than discovering the loop.
           */
          email: 'never',
          /* Dedupe window comfortably wider than the sweep's own. */
          withinDays: 30,
        });
      }
    }

    this.logger.log(
      `Email failure sweep: ${failures.length} failure(s) across ${byOrg.size} organization(s).`,
    );
    return { failures: failures.length, organizations: byOrg.size };
  }
}
