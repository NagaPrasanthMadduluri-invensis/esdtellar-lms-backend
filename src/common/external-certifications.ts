/**
 * External certifications — training a learner did somewhere else and is
 * asking to have counted here. Fifteenth catalogue-as-code.
 *
 * The four states below are read by the DTO that filters a queue, by the
 * service that decides who may act next, and by both portals' chips. One
 * list, so a state cannot be rendered that nothing can produce.
 */

/**
 * The approval chain, in order.
 *
 *   pending_manager -> the learner's manager is being asked whether they
 *                      really completed it
 *   pending_admin   -> the manager said yes (or there was no manager), and
 *                      L&D has the final call
 *   approved        -> counted: a companion course exists and the hours are
 *                      in the learner's total
 *   rejected        -> refused by either step, with a reason
 *
 * There is no `withdrawn`. A learner who submitted by mistake asks the
 * person already looking at it to reject it, which keeps one decision trail
 * rather than two ways for a row to end.
 */
export const EXTERNAL_CERT_STATUSES = [
  'pending_manager',
  'pending_admin',
  'approved',
  'rejected',
] as const;
export type ExternalCertStatus = (typeof EXTERNAL_CERT_STATUSES)[number];

export const EXTERNAL_CERT_STATUS_LABELS: Record<ExternalCertStatus, string> = {
  pending_manager: 'Waiting for your manager',
  pending_admin: 'Waiting for L&D',
  approved: 'Approved',
  rejected: 'Not approved',
};

/** Still moving. Used by both queues and by the learner's own list. */
export function isPending(status: string): boolean {
  return status === 'pending_manager' || status === 'pending_admin';
}

/**
 * What a certificate file may be.
 *
 * A PDF or a picture of the certificate — nothing that this server would
 * ever be asked to execute or render as markup. **Not SVG**, for the reason
 * §10.10 gives for thumbnails: it can carry script. The bytes are checked
 * against these signatures, never the declared Content-Type, which the
 * client writes.
 */
export const ALLOWED_CERTIFICATE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const CERTIFICATE_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** A scanned certificate, not a feature film. A constant, not an env var —
 *  the same call §10.10 makes for a course thumbnail. */
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The longest training anybody may claim in one submission, in hours.
 *
 * A cap exists because these hours are SELF-REPORTED and land in the same
 * total as measured learning (§10.4). A typo of 1000 for 100 would put one
 * learner at the top of every hours figure in the organization, and the
 * approver reading "1000 hours" has no way to tell a typo from a claim. It
 * is deliberately generous — a long professional qualification is real —
 * and the point is only that the number has a ceiling at all.
 */
export const MAX_CLAIMED_HOURS = 500;

/** The lesson `content_type` on the companion course an approval creates.
 *  Deliberately NOT in `LESSON_CONTENT_TYPES`: nothing authors one of these
 *  by hand, exactly like a session's companion lesson (§10.7). */
export const EXTERNAL_LESSON_CONTENT_TYPE = 'external';
