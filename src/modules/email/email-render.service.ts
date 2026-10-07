import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NOTIFICATION_TYPES } from '@/common/notifications';

import { DIRECT_EMAIL_TYPES, isDirectEmailType } from './email-types';
import { MAIL_BRAND as C, FONT_STACK } from './email-brand';
import { escapeHtml, renderLayout } from './templates/layout';

/**
 * The catalogue entry for a type, or undefined for the direct-email types
 * (password reset and friends) which are not notifications and have no
 * entry. Every caller falls back rather than assuming one exists.
 */
/** "New course assigned: X", without repeating a label the caller used. */
function subjectLine(label: string | undefined, stored: string): string {
  if (!label) return stored;
  const a = label.trim().toLowerCase();
  const b = stored.trim().toLowerCase();
  if (b.startsWith(a) || b === a) return stored;
  return `${label}: ${stored}`;
}

function typeDef(type: string) {
  return (NOTIFICATION_TYPES as Record<string, {
    label: string; cta: string; aspiration?: string;
  }>)[type];
}
import { createUnsubscribeToken } from './unsubscribe-token';
import type { OutboxRow } from './email-outbox.repository';
import type { OutgoingMail } from './mailer/mailer.interface';

/** Thrown when a row must not be sent as rendered. Not retryable. */
export class RenderRefusedError extends Error {}

@Injectable()
export class EmailRenderService {
  private readonly logger = new Logger(EmailRenderService.name);

  constructor(private readonly config: ConfigService) {}

  private get origin(): string {
    return (
      this.config.get<string>('clientOrigin') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private get secret(): string {
    return this.config.get<string>('auth.jwtSecret') ?? '';
  }

  /**
   * Turns a relative `link` into something a mail client can open.
   *
   * THE MOST CONSEQUENTIAL FUNCTION IN THIS MODULE. `clientOrigin` defaults
   * to `http://localhost:3000`, every `link` on a notification row is
   * relative, and an email is the one artefact in this product that cannot
   * be recalled, patched or re-rendered. A misconfigured origin discovered
   * after a 500-recipient fan-out is 500 dead links in 500 inboxes.
   *
   * So `assertSendable()` below refuses to send at all under a localhost
   * origin. Sending nothing is recoverable; sending garbage is not.
   */
  absoluteUrl(link: string | null | undefined): string {
    const origin = this.origin;
    if (!link) return origin;

    // A protocol-relative `//evil.test` would otherwise inherit our scheme
    // and resolve off-origin. The column is free text; today nothing writes
    // an absolute value, and "today" is not a guarantee.
    if (link.startsWith('//')) return origin;

    if (/^https?:\/\//i.test(link)) {
      return link.startsWith(origin) ? link : origin;
    }

    try {
      return new URL(link, `${origin}/`).toString();
    } catch {
      return origin;
    }
  }

  /**
   * Why this driver must not send right now, or null.
   *
   * Checked once per drain tick rather than per row — the answer cannot
   * change mid-batch, and a per-row check would log the same sentence 500
   * times.
   */
  assertSendable(driverKind: string): string | null {
    /*
     * Every driver that REALLY SENDS, not just SES.
     *
     * This read `driverKind !== 'ses'` when SES was the only real one, and
     * adding the Gmail driver silently widened the hole it exists to close:
     * mail would have gone out with every link pointing at localhost, which
     * is exactly the unrecallable failure the message below describes.
     *
     * `log` and `file` are exempt because nothing leaves the machine —
     * localhost links are correct for them.
     */
    if (driverKind === 'log' || driverKind === 'file') return null;
    const origin = this.origin;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(origin)) {
      return (
        `CLIENT_ORIGIN is ${origin}, which is not a public address. Every ` +
        'link in a sent email would be dead and could not be recalled. ' +
        'Set CLIENT_ORIGIN to the public UI origin and restart.'
      );
    }
    return null;
  }

  render(row: OutboxRow): OutgoingMail {
    const group = this.groupOf(row.type);
    const cta = this.ctaFor(row);

    /*
     * THE HEADLINE IS THE ACTION; the subject line names the thing.
     *
     * These emails used to lead with "New course: Leadership &
     * Communication", which says what it is ABOUT and not what HAPPENED.
     * A reader skimming an inbox needs the verb: was it assigned to me,
     * did I complete it, is it due? The catalogue already carries exactly
     * that sentence as `label` — it was only ever being used as a fallback
     * for a row with no title at all.
     *
     * So the H1 is the action and the stored subject becomes the line
     * under it. The envelope Subject stays as it was: in a list of
     * forty unread messages the specific course name is what distinguishes
     * one row from another.
     */
    const def = typeDef(row.type);
    const paragraphs: string[] = [];
    if (row.body) paragraphs.push(row.body);
    if (row.actorName) paragraphs.push(`Actioned by ${row.actorName}.`);
    if (paragraphs.length === 0) {
      // A notification with a title and no body is legal. Rather than ship
      // an empty email, say the one useful thing: go and look.
      paragraphs.push('There is an update waiting for you in Spectra LMS.');
    }

    /*
     * Facts the caller froze at enqueue (0041). Parsed defensively: this
     * is a jsonb column written by 24 call sites, and a malformed value
     * must cost the panel, never the email.
     */
    let facts: Array<{ label: string; value: string }> | undefined;
    if (row.facts) {
      try {
        const parsed = typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts;
        if (Array.isArray(parsed)) {
          const clean = parsed
            .filter((f) => f && typeof f.label === 'string' && typeof f.value === 'string')
            .map((f) => ({ label: String(f.label), value: String(f.value) }));
          if (clean.length) facts = clean;
        }
      } catch {
        /* a bad panel is not worth losing the message over */
      }
    }

    const { footerExtraHtml, headers } = this.footerAndHeaders(row);

    const { html, text } = renderLayout({
      group,
      title: def?.label ?? row.subject,
      // The specific thing this is about, under the action.
      subtitle: def?.label && def.label !== row.subject ? row.subject : undefined,
      facts,
      aspiration: def?.aspiration,
      paragraphs,
      cta,
      orgName: row.orgName,
      /*
       * Frozen on the row at enqueue (0040), never joined at send time.
       *
       * Absolutised through the same `absoluteUrl` the CTA uses: the stored
       * value is a path, and a relative src in an email resolves against
       * nothing at all — every client would show a broken image.
       */
      orgLogoUrl: row.orgLogoUrl ? this.absoluteUrl(row.orgLogoUrl) : null,
      footerExtraHtml,
      preheader: row.body ?? undefined,
    });

    return {
      to: row.toEmail,
      toName: row.toName,
      // Verbatim, with no `[Spectra LMS]` prefix: a prefix burns the width
      // an inbox gives the subject line and reads as bulk mail.
      /*
       * ACTION then NAME — "New course assigned: Data Analytics
       * Fundamentals".
       *
       * The stored subject is just the thing's name, because that is what
       * reads well as the subtitle inside the email. On its own in an
       * inbox it says nothing: forty unread rows of bare course names
       * give the reader no idea which need them. Prefixing the catalogue's
       * action label costs nothing and makes the list scannable.
       *
       * Skipped when the stored subject already opens with the label, so
       * a caller that composed its own full sentence is not doubled up.
       */
      subject: subjectLine(def?.label, row.subject),
      html,
      text,
      headers,
    };
  }

  private groupOf(type: string): string {
    if (isDirectEmailType(type)) return DIRECT_EMAIL_TYPES[type].group;
    const def = (
      NOTIFICATION_TYPES as Record<string, { group: string } | undefined>
    )[type];
    return def?.group ?? 'learning';
  }

  /**
   * The button label is chosen from the group rather than written per type,
   * for the same reason there is one layout: the wording that identifies the
   * thing is already in the subject and body.
   */
  private ctaFor(row: OutboxRow): { label: string; url: string } | undefined {
    if (isDirectEmailType(row.type)) {
      if (row.type === 'password_changed') return undefined;
      return {
        label: row.type === 'password_reset' ? 'Reset my password' : 'Sign in',
        url: this.absoluteUrl(row.link),
      };
    }
    if (!row.link) return undefined;
    /*
     * The button's words come from the TYPE, not the group.
     *
     * Five group labels meant "Open in Spectra LMS" on everything from a
     * new course to a revoked certificate — a button that names no
     * destination, which is the one people do not press. The catalogue
     * carries a per-type `cta` ("Start learning", "View my certificate")
     * so the button states what pressing it does.
     */
    return {
      label: typeDef(row.type)?.cta ?? 'Open in Spectra LMS',
      url: this.absoluteUrl(row.link),
    };
  }

  /**
   * The footer's manage/unsubscribe lines, and the `List-Unsubscribe`
   * headers that go with them.
   *
   * An `announcement` gets both the header pair and a visible unsubscribe
   * link; a `transactional` message gets neither, and offers "manage your
   * email settings" instead. That asymmetry is deliberate and is the whole
   * reason `policy` is a stored column rather than a boolean: telling
   * somebody they can unsubscribe from a password reset would be a control
   * that lies, and NOT telling an announcement's recipient is what gets a
   * sending domain reported.
   */
  private footerAndHeaders(row: OutboxRow): {
    footerExtraHtml: string;
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    const settingsUrl = `${this.origin}/settings/notifications`;
    const small = `font-family:${FONT_STACK};font-size:11px;line-height:1.55;color:${C.text3};`;

    if (isDirectEmailType(row.type)) {
      return {
        footerExtraHtml: `<p style="margin:0;${small}">This is a security message about your account, so it is always sent.</p>`,
        headers,
      };
    }

    const manage = `<a href="${escapeHtml(settingsUrl)}" style="color:${C.accent};text-decoration:underline;">Manage your email settings</a>`;

    if (row.policy !== 'announcement') {
      return {
        footerExtraHtml: `<p style="margin:0;${small}">${manage}</p>`,
        headers,
      };
    }

    const group = this.groupOf(row.type);
    const token = createUnsubscribeToken(this.secret, row.userId, group);
    const unsubUrl = `${this.origin}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;

    // RFC 8058. The POST variant is what makes Gmail and Yahoo render their
    // own one-click control, which is the thing that keeps a reader from
    // reaching for the spam button instead.
    headers['List-Unsubscribe'] = `<${unsubUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

    return {
      footerExtraHtml:
        `<p style="margin:0;${small}">${manage} &nbsp;·&nbsp; ` +
        `<a href="${escapeHtml(unsubUrl)}" style="color:${C.accent};text-decoration:underline;">Unsubscribe from these emails</a></p>`,
      headers,
    };
  }
}
