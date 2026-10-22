/**
 * Data-subject request vocabulary (0056) — the validator source for the DTOs
 * and the states the admin queue advances through.
 *
 * A request is born `open` and only an admin moves it on. A `correction` asks
 * for a record to be fixed; a `deletion` asks for personal data to be removed.
 * Neither executes on the subject's click — see the migration header.
 *
 * `client/lib/data-requests.js` mirrors this (labels + chip tones). Change both.
 */
export const DATA_REQUEST_TYPES = ['correction', 'deletion'] as const;
export type DataRequestType = (typeof DATA_REQUEST_TYPES)[number];

export const DATA_REQUEST_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'rejected',
] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

export const DATA_REQUEST_STATUS_DEFAULT: DataRequestStatus = 'open';

/** The statuses that count as still needing an admin's attention. */
export const DATA_REQUEST_OPEN_STATUSES: readonly DataRequestStatus[] = [
  'open',
  'in_progress',
];
