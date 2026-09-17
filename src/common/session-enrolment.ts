/**
 * How people get onto a session, and what state a batch is in.
 *
 * Eighth catalogue-as-code here. Both lists are validated by a DTO, so a value
 * outside them is refused with a 422 naming the valid set rather than stored
 * and rendered as an unknown chip.
 */

/** How learners join a session's roster. */
export const ENROLL_MODES = ['assigned', 'self'] as const;
export type EnrollMode = (typeof ENROLL_MODES)[number];

export const ENROLL_MODE_LABELS: Record<EnrollMode, string> = {
  assigned: 'Admin assigned',
  self: 'Self enrolment',
};

/**
 * A batch's stored status.
 *
 * `pending` is NOT here on purpose: a batch with no date yet is pending, and
 * that is derived from `date IS NULL` rather than stored. Storing it too would
 * let the two disagree — a dated batch still marked pending, or the reverse —
 * the same reason `display_status` is derived on the session itself (§10.7).
 */
export const BATCH_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** What the UI shows, including the derived state. */
export type BatchDisplayStatus = BatchStatus | 'pending';

export function batchDisplayStatus(batch: {
  status: string;
  date: string | null;
}): BatchDisplayStatus {
  if (batch.status === 'cancelled' || batch.status === 'completed') {
    return batch.status;
  }
  return batch.date ? 'scheduled' : 'pending';
}
