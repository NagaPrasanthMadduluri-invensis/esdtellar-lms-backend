import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { NOTIFICATION_TYPES, type EmailPolicy } from '@/common/notifications';
import { EMAIL_CONSTANTS } from '@/config/configuration';

import {
  EmailOutboxRepository,
  type NewOutboxRow,
  type RecipientRow,
} from './email-outbox.repository';
import {
  DIRECT_EMAIL_TYPES,
  UNSUPPRESSABLE,
  isDirectEmailType,
} from './email-types';

/** What `notify()` hands over, plus what a direct email supplies itself. */
export interface EnqueueInput {
  /**
   * A DIFFERENT link per recipient, keyed by user id.
   *
   * Exists for one shape the shared `link` cannot express: a welcome or a
   * password reset carries a ONE-TIME TOKEN, so every recipient's URL is
   * unique. Without this, a batch of 300 welcomes would be 300 separate
   * `enqueue` calls — 300 recipient lookups and 300 INSERTs inside one HTTP
   * request, the N+1 §7.1 forbids on the slowest path in the product.
   *
   * When a user id is absent from the map their row falls back to `link`.
   * A map with an entry for everybody and no `link` at all is the normal
   * case for a credential batch.
   */
  linkByUserId?: Map<number, string>;
  /** Display facts for the email's panel, frozen at enqueue (0041). */
  facts?: Array<{ label: string; value: string }> | null;
  /** The bare name of the subject, for the email's subheading (0042). */
  subjectName?: string | null;
  organizationId: number;
  type: string;
  userIds: number[];
  subject?: string;
  body?: string | null;
  link?: string | null;
  actorName?: string | null;
  subjectType?: string | null;
  subjectId?: number | null;
  /** Paired with userIds by index, for the forensic column. Optional. */
  notificationIds?: number[];
  /** Skip the email channel for this call regardless of policy. */
  skipEmail?: boolean;
}

/**
 * Decides who gets an email, and writes the rows. Sends nothing.
 *
 * ## The never-throws contract
 *
 * Identical to `NotificationsService.notify()`, and carried by DUPLICATING
 * the discipline rather than by nesting inside it: this class has its own
 * try/catch, its own Logger and its own message.
 *
 * That separation is the point. Before it, a failure here would have been
 * caught by notify()'s existing handler and logged as "Notification not
 * sent" — which would have been false, since the notification went fine. A
 * log line that misnames what broke is worse than no log line, because it
 * sends whoever reads it to the wrong file.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<boolean>('email.enabled') ?? false;
  }

  private get allowlist(): string[] {
    return this.config.get<string[]>('email.allowlist') ?? [];
  }

  private get maxRecipients(): number {
    return EMAIL_CONSTANTS.maxRecipientsPerNotify;
  }

  policyFor(type: string): EmailPolicy {
    if (isDirectEmailType(type)) return DIRECT_EMAIL_TYPES[type].policy;
    const def = (
      NOTIFICATION_TYPES as Record<string, { email: EmailPolicy } | undefined>
    )[type];
    return def?.email ?? 'none';
  }

  groupFor(type: string): string {
    if (isDirectEmailType(type)) return DIRECT_EMAIL_TYPES[type].group;
    const def = (
      NOTIFICATION_TYPES as Record<string, { group: string } | undefined>
    )[type];
    return def?.group ?? 'learning';
  }

  /** Never throws. Returns how many rows were written, for logging only. */
  async enqueue(input: EnqueueInput): Promise<number> {
    try {
      return await this.run(input);
    } catch (error) {
      this.logger.warn(
        `Email not enqueued (${input.type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  private async run(input: EnqueueInput): Promise<number> {
    if (!this.enabled || input.skipEmail) return 0;

    const policy = this.policyFor(input.type);
    if (policy === 'none') return 0;

    const userIds = [...new Set(input.userIds)].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (userIds.length === 0) return 0;

    /**
     * ABOVE THE CEILING WE SKIP, WE DO NOT TRUNCATE.
     *
     * Truncating would email some of a department and not the rest, with
     * nothing on any screen saying which — a difference nobody notices for
     * weeks. Skipping produces one loud log line somebody can act on, and
     * the bell rows are written either way, so no one loses the information.
     */
    if (userIds.length > this.maxRecipients) {
      this.logger.error(
        `Email SKIPPED for ${input.type}: ${userIds.length} recipients ` +
          `exceeds the ${this.maxRecipients} ceiling (org ` +
          `${input.organizationId}). Bell notifications were still written. ` +
          'Raise EMAIL_CONSTANTS.maxRecipientsPerNotify deliberately if ' +
          'this fan-out is intended.',
      );
      return 0;
    }

    const recipients = await this.repository.recipients(userIds);
    if (recipients.length === 0) return 0;

    const subject = input.subject?.trim() || this.fallbackSubject(input.type);
    const group = this.groupFor(input.type);
    const notificationIdFor = this.idPairer(userIds, input.notificationIds);

    const send: NewOutboxRow[] = [];
    const blocked: NewOutboxRow[] = [];

    for (const r of recipients) {
      const row: NewOutboxRow = {
        organizationId: input.organizationId,
        userId: r.user_id,
        notificationId: notificationIdFor(r.user_id),
        type: input.type,
        policy,
        toEmail: r.email,
        toName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        // Frozen with the name, for the reason 0040 gives: the queue drains
        // later, and a logo changed in between must not silently re-brand
        // mail about things that happened under the old one.
        orgLogoUrl: r.org_logo_url,
        // Serialised once here, frozen with the rest (0041).
        facts: input.facts?.length ? JSON.stringify(input.facts) : null,
        subjectName: input.subjectName ?? null,
        orgName: r.org_name,
        subject,
        body: input.body ?? null,
        link: input.linkByUserId?.get(r.user_id) ?? input.link ?? null,
        actorName: input.actorName ?? null,
        dedupeKey: this.dedupeKey(input, r.user_id),
      };

      const refusal = this.gate(r, policy, input.type, group);
      if (refusal) {
        // A plain opt-out writes NOTHING. 500 rows recording that 500 people
        // did not want an email is 500 rows of noise per fan-out.
        continue;
      }

      // The allowlist is the one case that DOES write a suppressed row,
      // because the whole purpose of a dry run is to count what would have
      // been sent.
      if (!this.allowed(r.email)) {
        blocked.push(row);
        continue;
      }

      send.push(row);
    }

    const [written, suppressed] = await Promise.all([
      this.repository.enqueue(send),
      this.repository.enqueueSuppressed(blocked, 'not_allowlisted'),
    ]);

    if (suppressed > 0) {
      this.logger.log(
        `${input.type}: ${written} queued, ${suppressed} held by EMAIL_ALLOWLIST.`,
      );
    }
    return written;
  }

  /**
   * Why this recipient must not be emailed, or null.
   *
   * Order is cheapest-first and the last check is the strongest: a
   * suppression outranks every preference AND every unsuppressable type,
   * because a hard-bounced address cannot receive mail whatever we decide
   * about it.
   */
  private gate(
    r: RecipientRow,
    policy: EmailPolicy,
    type: string,
    group: string,
  ): string | null {
    if (r.suppressed) return 'suppressed';

    /**
     * Password reset ignores `all_off`.
     *
     * The master switch is honoured for everything else — §10.18's promise
     * that nothing in the notification system is the only way somebody
     * learns something is what makes that safe. These two break the promise
     * by design: there is no screen to check, because the person cannot
     * sign in. Honouring the switch there would turn a preference into a
     * permanent lockout.
     */
    if (UNSUPPRESSABLE.has(type)) return null;

    if (r.all_off) return 'all_off';

    if (policy === 'announcement') {
      if (!r.org_announcements) return 'org_announcements_off';
      const off = r.groups_off.split(',').filter(Boolean);
      if (off.includes(group)) return 'group_off';
    }

    return null;
  }

  /** Empty allowlist means everyone. An entry may be an address or @domain. */
  private allowed(email: string): boolean {
    const list = this.allowlist;
    if (list.length === 0) return true;
    const addr = email.toLowerCase();
    return list.some((entry) =>
      entry.startsWith('@') ? addr.endsWith(entry) : addr === entry,
    );
  }

  /**
   * Guards against the same APPLICATION EVENT being enqueued twice — a
   * double-clicked Save, a retried request.
   *
   * The five-minute bucket is the whole trick. It cannot plausibly suppress
   * a genuinely intended second message, because nobody assigns the same
   * course to the same person twice inside five minutes on purpose, and it
   * reliably kills the accidental repeat.
   *
   * This is NOT the same problem as the worker retrying — that is handled by
   * the row's own state machine. Conflating the two produces a design that
   * drops mail trying to be exactly-once.
   */
  private dedupeKey(input: EnqueueInput, userId: number): string {
    const bucket = Math.floor(Date.now() / 300_000);
    return createHash('sha256')
      .update(
        [
          input.type,
          userId,
          input.subjectType ?? '',
          input.subjectId ?? '',
          bucket,
        ].join(':'),
      )
      .digest('hex');
  }

  private idPairer(
    userIds: number[],
    notificationIds?: number[],
  ): (userId: number) => number | null {
    if (!notificationIds || notificationIds.length !== userIds.length) {
      return () => null;
    }
    const map = new Map<number, number>();
    userIds.forEach((id, i) => map.set(id, notificationIds[i]));
    return (userId) => map.get(userId) ?? null;
  }

  private fallbackSubject(type: string): string {
    if (isDirectEmailType(type)) return DIRECT_EMAIL_TYPES[type].label;
    const def = (
      NOTIFICATION_TYPES as Record<string, { label: string } | undefined>
    )[type];
    return def?.label ?? 'Spectra LMS';
  }
  /**
   * Recent give-ups, for the sweep that tells each organization's admins.
   *
   * Exposed on the SERVICE because `EmailOutboxRepository` is not exported
   * (§3.2) and must not be — a module reaching into this table directly
   * would bypass the enqueue gate that the whole preference and suppression
   * model depends on. A read is the safe half to hand out.
   */
  async recentFailures(withinHours = 48) {
    return this.repository.recentFailures(withinHours);
  }

  /**
   * Of these users, which already have a welcome outbox row.
   *
   * The reconcile sweep's idempotency guard (§10.33): a learner whose flag
   * lingered but whose welcome WAS queued must have the flag cleared, not a
   * second welcome enqueued. Exposed on the service because
   * `EmailOutboxRepository` is not exported (§3.2).
   */
  async usersWithWelcome(userIds: number[]): Promise<Set<number>> {
    return this.repository.usersWithWelcome(userIds);
  }

}
