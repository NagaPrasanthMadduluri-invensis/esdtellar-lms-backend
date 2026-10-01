/**
 * The Spectra palette, server side, for email only.
 *
 * ## Why this file exists at all
 *
 * TASTE §10.1 closes the palette and says `lib/brand.js` is the JS mirror of
 * `globals.css`, and that the two must move together. This is a THIRD copy,
 * which normally would be exactly the drift that section warns about — so the
 * justification has to be good:
 *
 *   - An email is rendered in a different process from the browser, by code
 *     that cannot import from `client/`. AGENTS.md makes that a hard rule:
 *     the HTTP API is the only interface between the two packages.
 *   - Email HTML cannot use CSS variables, a stylesheet, or a class. Every
 *     colour has to be a literal hex inlined on the element, because Gmail
 *     strips `<style>` blocks and Outlook never understood custom properties.
 *
 * So the values are duplicated and the duplication is contained to this one
 * file. If a hue moves in `globals.css`, it moves here too — the same
 * standing rule §10.1 already states for `lib/brand.js`.
 *
 * Only the tokens an email actually paints are mirrored. The chart ramp, the
 * learning-type colours and the tinted tile classes have no meaning here.
 */
export const MAIL_BRAND = {
  /* Chrome — the header band and the primary button */
  navy: '#1E2D40',
  navySoft: '#25344D',
  navyDeep: '#192636',

  /* The one interactive accent. On navy it must become accentSoft (§10.1). */
  accent: '#3B6FD4',
  accentSoft: '#BDD0F0',
  accentTint: '#F0F5FC',

  /* Status hues, used for the group rule and the alert panel */
  success: '#1A5E3A',
  warning: '#8A6200',
  rust: '#B04A00',
  danger: '#C94040',

  /* Light surfaces. The canvas is the DARKEST — panels lift off it. */
  canvas: '#EDECE9',
  surface: '#FFFFFF',
  surface2: '#F8F8F6',
  surface3: '#EFEEEB',
  line: '#D8D8D4',

  /* Text ramp */
  ink: '#0F1923',
  text2: '#555555',
  text3: '#888888',
} as const;

/** §10.2.1 — the name lives in one constant, and a rename must not miss one. */
export const PRODUCT_NAME = 'Spectra LMS';
export const PRODUCT_BY = 'By Edstellar';
export const PRODUCT_FULL = `${PRODUCT_NAME} by Edstellar`;

/**
 * Each notification group gets the hue it already carries in the product, so
 * an email and the bell row it mirrors read as the same thing.
 *
 * These are the FLAT tokens, not the chart weights — a 3px rule and a small
 * caps label, which is exactly what §10.1.1 says flat is for.
 */
export const GROUP_STYLE: Record<string, { color: string; label: string }> = {
  learning: { color: MAIL_BRAND.accent, label: 'Learning' },
  sessions: { color: MAIL_BRAND.success, label: 'Sessions' },
  recognition: { color: MAIL_BRAND.warning, label: 'Recognition' },
  people: { color: MAIL_BRAND.navy, label: 'People' },
  commercial: { color: MAIL_BRAND.rust, label: 'Account' },
  security: { color: MAIL_BRAND.danger, label: 'Security' },
};

export function groupStyle(group: string): { color: string; label: string } {
  return GROUP_STYLE[group] ?? GROUP_STYLE.learning;
}

/**
 * Inter is not web-safe and an email cannot load a font, so the stack starts
 * with it for the handful of clients that have it locally and falls through
 * to each platform's own UI face. Never a web font: Gmail strips `@font-face`
 * and Outlook renders Times New Roman when a stack fails to resolve.
 */
export const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, " +
  "'Helvetica Neue', Arial, sans-serif";

export const MONO_STACK =
  "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
