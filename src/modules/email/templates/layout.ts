import {
  FONT_STACK,
  MAIL_BRAND as C,
  MONO_STACK,
  PRODUCT_BY,
  PRODUCT_FULL,
  PRODUCT_NAME,
  groupStyle,
} from '../email-brand';

/**
 * ONE layout, not twenty-six templates.
 *
 * ## Why there is only one
 *
 * The title and body of a notification are composed at WRITE time, by the
 * service that had the course and the actor in hand, as a finished sentence
 * pair for a human (see the header of `common/notifications.ts`). Writing a
 * template per type would put that wording in a second place — rendered
 * minutes later, in a different process, from data that may since have been
 * renamed or deleted. That is precisely the failure the denormalised `title`
 * and `actor_name` columns exist to prevent.
 *
 * So the content comes in; the layout decides only how it looks.
 *
 * ## Why it is all tables and inline styles
 *
 * This is not a stylistic choice and it should not be "cleaned up":
 *
 *   - Gmail strips `<style>` blocks from the `<head>`, so every rule has to
 *     be a `style=` attribute on the element it affects.
 *   - Outlook on Windows renders through Word, which does not support
 *     `float`, `flex`, `grid`, `max-width` on a div, or `background-image`
 *     on anything but a table cell.
 *   - CSS custom properties resolve nowhere, which is why `email-brand.ts`
 *     exists as literal hexes rather than reading the tokens.
 *
 * The Spectra rules still hold, and they happen to suit email: `--radius` is
 * 0, so nothing is rounded; nothing casts a shadow; every edge is a 1px
 * `line` border. A square, hairline-ruled email is both on-brand and the
 * easiest kind to make render identically everywhere.
 */

export interface LayoutParts {
  /** Small caps word above the heading — the notification group. */
  group: string;
  /**
   * The heading, and it states the ACTION — "New course assigned", not
   * "New course: Leadership & Communication". A reader skimming an inbox
   * needs the verb before the noun.
   */
  title: string;
  /**
   * The specific thing the action happened to, set under the heading.
   *
   * Separate from `title` because they answer different questions and are
   * read at different speeds: the action is scanned, the name is read.
   * Omitted when it would merely repeat the heading.
   */
  subtitle?: string;
  /**
   * One encouraging line under the button. Absent on administrative types
   * — see the catalogue — because filler on every email teaches people to
   * skip all of them.
   */
  aspiration?: string;
  /** One or more paragraphs of body copy. */
  paragraphs: string[];
  /** The one call to action. Omitted when there is nowhere useful to go. */
  cta?: { label: string; url: string };
  /** Key/value rows rendered as a bordered panel — dates, venues, scores. */
  facts?: Array<{ label: string; value: string }>;
  /** A tinted callout. `tone` picks the hue; `danger` is for real failure. */
  callout?: { tone: 'accent' | 'success' | 'warning' | 'danger'; text: string };
  /** Who the recipient is, for the footer's "you are receiving this" line. */
  orgName?: string | null;
  /**
   * The organization's own mark, absolute. Null for most tenants, and the
   * header falls back to the product wordmark rather than leaving a gap.
   */
  orgLogoUrl?: string | null;
  /** Rendered under the footer rule. Already-escaped HTML. */
  footerExtraHtml?: string;
  /** The preheader — the grey text a client shows beside the subject. */
  preheader?: string;
}

/**
 * Escapes text for interpolation into HTML.
 *
 * Applied WITHOUT EXCEPTION to every caller-supplied string below. Course
 * names are user input, they already arrive wrapped in quotes from the
 * services that compose these sentences, and an unescaped `<` would be an
 * HTML injection into every recipient's inbox — the one place in this
 * product where output cannot be recalled or patched.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CALLOUT_TONES = {
  accent: { border: C.accent, bg: C.accentTint, text: C.ink },
  success: { border: C.success, bg: '#E8F1EC', text: C.ink },
  warning: { border: C.warning, bg: '#F6F0E1', text: C.ink },
  danger: { border: C.danger, bg: '#F9EAEA', text: C.ink },
} as const;

export function renderLayout(parts: LayoutParts): {
  html: string;
  text: string;
} {
  const g = groupStyle(parts.group);
  const title = escapeHtml(parts.title);

  /**
   * The preheader. Hidden, but it is the second line every inbox shows under
   * the subject — left out, clients fill it with whatever text comes first,
   * which here would be the word "Learning". The trailing entities stop Gmail
   * pulling the footer up into the preview.
   */
  const preheader = escapeHtml(parts.preheader ?? parts.paragraphs[0] ?? '');

  const subtitle = parts.subtitle
    ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.45;font-weight:600;color:${C.ink};">${escapeHtml(parts.subtitle)}</p>`
    : '';

  /* Set apart from the body: it is encouragement, not instruction, and
     reading as another instruction is what makes it grating. */
  const aspiration = parts.aspiration
    ? `<p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:${C.text3};">${escapeHtml(parts.aspiration)}</p>`
    : '';

  const paragraphs = parts.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${C.text2};">${escapeHtml(p)}</p>`,
    )
    .join('');

  const facts = parts.facts?.length
    ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid ${C.line};background:${C.surface2};margin:4px 0 20px;">
            ${parts.facts
              .map(
                (f, i) => `
            <tr>
              <td style="padding:10px 14px;font-family:${MONO_STACK};font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:${C.text3};white-space:nowrap;vertical-align:top;${i ? `border-top:1px solid ${C.line};` : ''}">${escapeHtml(f.label)}</td>
              <td style="padding:10px 14px 10px 0;font-size:13px;color:${C.ink};font-weight:600;vertical-align:top;${i ? `border-top:1px solid ${C.line};` : ''}">${escapeHtml(f.value)}</td>
            </tr>`,
              )
              .join('')}
          </table>`
    : '';

  const callout = parts.callout
    ? (() => {
        const t = CALLOUT_TONES[parts.callout!.tone];
        return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="margin:0 0 20px;">
            <tr>
              <td style="padding:12px 14px;background:${t.bg};border-left:3px solid ${t.border};font-size:13px;line-height:1.55;color:${t.text};">${escapeHtml(parts.callout!.text)}</td>
            </tr>
          </table>`;
      })()
    : '';

  /**
   * The button is a table, not an `<a>` with padding: Outlook ignores padding
   * on an inline element, which collapses the button to bare underlined text.
   * `bg-navy` with an `accent-soft` label is §10.1's rule for accent ON navy
   * — `accent-blue` there measures 3.73:1 and is the defect that section
   * records shipping once already.
   */
  const cta = parts.cta
    ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">
            <tr>
              <td style="background:${C.navy};">
                <a href="${escapeHtml(parts.cta.url)}"
                   style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:600;color:${C.accentSoft};text-decoration:none;">${escapeHtml(parts.cta.label)}</a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 4px;font-size:11px;line-height:1.5;color:${C.text3};">
            If the button does not work, copy this into your browser:<br />
            <span style="color:${C.text2};word-break:break-all;">${escapeHtml(parts.cta.url)}</span>
          </p>`
    : '';

  /*
   * Built here rather than inline: a nested template literal inside the
   * HTML one terminates the outer literal, which is the same trap SQL
   * comments hit in BACKEND_STRUCTURE 10.26.
   */
  const logoTag = parts.orgLogoUrl
    ? '<img src="' + escapeHtml(parts.orgLogoUrl) + '" alt="" height="28" '
      + 'style="max-height:28px;width:auto;border:0;display:block;margin-bottom:8px;" />'
    : '';

  const orgLine = parts.orgName
    ? `You are receiving this because you have a ${escapeHtml(PRODUCT_NAME)} account at ${escapeHtml(parts.orgName)}.`
    : `You are receiving this because you have a ${escapeHtml(PRODUCT_NAME)} account.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${C.canvas};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.canvas};">
  <tr>
    <td align="center" style="padding:24px 16px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
             style="width:600px;max-width:100%;border:1px solid ${C.line};background:${C.surface};">

        <!-- The navy chrome, matching the product's top bar. The byline takes
             accent-soft because accent-blue on navy is unreadable (§10.1).

             IT LEADS WITH THE ORGANIZATION, not the product. The mail is
             about the learner's employer's training, sent by their employer;
             the product is the byline underneath. A tenant with no name
             recorded falls back to the product, so the header is never
             blank.

             The logo is an img with a max-height and no width, because a
             tenant's mark is whatever shape they uploaded and a fixed box
             would squash a wordmark. Outlook ignores max-height, which is
             why the tag also carries a real height attribute — and why
             the NAME is always rendered beside it rather than replaced by
             it: an image that does not load, or is blocked by default as
             most clients do, must not leave an unlabelled email. -->
        <tr>
          <td style="background:${C.navy};padding:18px 28px;">
            ${logoTag}
            <div style="font-family:${FONT_STACK};font-size:18px;font-weight:700;color:#FFFFFF;line-height:1.1;">${escapeHtml(parts.orgName || PRODUCT_NAME)}</div>
            <div style="font-family:${MONO_STACK};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${C.accentSoft};line-height:1.1;padding-top:4px;">${escapeHtml(parts.orgName ? PRODUCT_FULL : PRODUCT_BY)}</div>
          </td>
        </tr>

        <!-- The group's own hue as a 3px rule, so an email reads as the same
             kind of thing as the bell row it mirrors. -->
        <tr><td style="height:3px;background:${g.color};font-size:0;line-height:0;">&nbsp;</td></tr>

        <tr>
          <td style="padding:28px;font-family:${FONT_STACK};">
            <div style="font-family:${MONO_STACK};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${g.color};font-weight:600;padding-bottom:10px;">${escapeHtml(g.label)}</div>
            <h1 style="margin:0 0 10px;font-size:21px;line-height:1.3;font-weight:700;color:${C.ink};">${title}</h1>
            ${subtitle}
            ${paragraphs}
            ${callout}
            ${facts}
            ${cta}
            ${aspiration}
          </td>
        </tr>

        <tr>
          <td style="padding:16px 28px 22px;border-top:1px solid ${C.line};background:${C.surface2};font-family:${FONT_STACK};">
            <p style="margin:0 0 6px;font-size:11px;line-height:1.55;color:${C.text3};">${orgLine}</p>
            ${parts.footerExtraHtml ?? ''}
          </td>
        </tr>
      </table>

      <div style="font-family:${FONT_STACK};font-size:10.5px;color:${C.text3};padding-top:14px;">${escapeHtml(PRODUCT_BY.replace(/^By /, ''))}</div>

    </td>
  </tr>
</table>
</body>
</html>`;

  /**
   * The plain-text part is not optional. A message with no `text/plain`
   * alternative scores against you with every spam filter there is, and the
   * cost here is near zero precisely BECAUSE the content is a title, some
   * paragraphs and a URL rather than a bespoke layout.
   */
  const textLines: string[] = [
    g.label.toUpperCase(),
    '',
    parts.title,
    '',
    ...parts.paragraphs.flatMap((p) => [p, '']),
  ];
  if (parts.callout) textLines.push(parts.callout.text, '');
  if (parts.facts?.length) {
    for (const f of parts.facts) textLines.push(`${f.label}: ${f.value}`);
    textLines.push('');
  }
  if (parts.cta) textLines.push(parts.cta.label, parts.cta.url, '');
  textLines.push('—', orgLine.replace(/&amp;/g, '&'), PRODUCT_FULL_TEXT);

  return { html, text: textLines.join('\n') };
}

const PRODUCT_FULL_TEXT = `${PRODUCT_NAME} — ${PRODUCT_BY.replace(/^By /, '')}`;
