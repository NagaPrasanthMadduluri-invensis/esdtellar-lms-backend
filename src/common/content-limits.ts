/**
 * Limits on free-text content fields, in one place.
 *
 * A description is a summary shown on a card, not an article: the UI clamps it
 * to two lines everywhere it is listed, so text beyond a few sentences is
 * written but never read. Capping it keeps what the admin types and what the
 * learner sees from drifting apart, and stops one long paragraph from setting
 * the height of a whole grid of cards.
 *
 * 450 is the agreed number and it applies to EVERY description — course,
 * module, lesson, assessment, session. One limit, so an admin never has to
 * learn which form is stricter.
 *
 * The columns behind these are `text`, deliberately: the cap is a product rule
 * that may move, and a rule that moves does not belong in a type that needs a
 * migration to change. No existing row was over the limit when it was
 * introduced (the longest was 198 characters), so nothing became uneditable.
 *
 * `client/lib/content-limits.js` mirrors this. Change both.
 */
export const DESCRIPTION_MAX_LENGTH = 450;

/** The message every description field gives, so they cannot drift apart. */
export const DESCRIPTION_TOO_LONG = `description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`;

/**
 * Learning Community free text. A post body is long-form (a question, a
 * discussion, an achievement caption), so it is NOT the 450-char description
 * cap — it has its own, larger limit. Titles stay short. `client/lib/
 * content-limits.js` mirrors these — change both.
 */
export const COMMUNITY_TITLE_MAX = 160;
export const COMMUNITY_BODY_MAX = 4000;

/**
 * A direct message between two people. Shorter than a community post — a DM is
 * a line or two, not an essay — but longer than a card description. Its column
 * is `text`, same reasoning as the others. `client/lib/content-limits.js`
 * mirrors it — change both.
 */
export const MESSAGE_MAX_LENGTH = 2000;
