/**
 * The notification catalogue — the eleventh catalogue-as-code, after
 * `permissions`, `badges`, `workforce`, `course-taxonomy`, `lesson-content`,
 * `assessment-questions`, `edstellar-services`, `session-enrolment`,
 * `tenant-account` and `billing`.
 *
 * Same argument every time: a value means something only because something
 * reads it. Here two things do — the bell's icon and grouping, and the
 * `@IsIn` on the read/filter DTO — so the list lives in code beside the
 * services that write it, and the browser mirrors it in
 * `client/lib/notifications.js`.
 *
 * What is NOT here is the wording. `title` and `body` are composed at write
 * time and stored on the row, because they name a course or a person that may
 * later be renamed or deleted, and a notification describing what happened
 * then must keep saying that. The catalogue owns only what is stable: which
 * audience a type belongs to, how it groups, and which icon it takes.
 */

/** Which portal's bell a type can appear in. Documentation, and a guard. */
export type NotificationAudience = 'learner' | 'admin' | 'trainer' | 'platform';

export interface NotificationTypeDef {
  /** Fallback label when a row somehow has no title. */
  label: string;
  /** Colours the icon and groups the list. */
  group: 'learning' | 'recognition' | 'sessions' | 'people' | 'commercial';
  /** A lucide component NAME (§10.3.1.6) — the browser maps it. */
  icon: string;
  /** Who this type is ever sent to. */
  audience: NotificationAudience[];
  /**
   * How this type reaches an INBOX, on top of the bell.
   *
   *   transactional — a decision or an obligation addressed to one named
   *                   person. Suppressed only by the master switch.
   *   announcement  — news broadcast to an audience. Opt-outable per group,
   *                   carries List-Unsubscribe, and additionally requires
   *                   the organization to have turned announcements on.
   *   none          — bell only, never emailed.
   *
   * This belongs in the catalogue rather than a parallel `email-policy.ts`
   * for the reason the header gives: it is a STABLE, structural fact decided
   * once per type, exactly like `audience`. A parallel map would be free to
   * drift, and — because the object below is `satisfies Record<string,
   * NotificationTypeDef>` — putting it here makes a 26th type a COMPILE
   * ERROR until somebody decides how it reaches an inbox. That error is the
   * whole value.
   *
   * It is deliberately not a boolean. "Does it email" and "may the recipient
   * refuse it" are different questions with different legal consequences,
   * and a boolean collapses them.
   */
  email: EmailPolicy;
  /**
   * The words on the email's button.
   *
   * Per type because "Open in Spectra LMS" tells the reader nothing about
   * what happens next, and a button that does not name its destination is
   * the one people do not press. "Start learning" and "View my certificate"
   * are different promises and should not share a label.
   */
  cta: string;
  /**
   * One optional line under the button, saying why this matters.
   *
   * Deliberately absent on the administrative and commercial types: an
   * encouraging sentence under "Seat request raised" reads as filler, and
   * filler on every email is how people stop reading any of them.
   */
  aspiration?: string;
}

/** @see NotificationTypeDef.email */
export type EmailPolicy = 'transactional' | 'announcement' | 'none';

export const NOTIFICATION_TYPES = {
  /* ── The learner's own learning ── */
  course_assigned: {
    label: 'New course assigned',
    group: 'learning',
    icon: 'BookOpen',
    audience: ['learner'],
    email: 'transactional',
    cta: 'Start learning',
    aspiration: 'Every course you finish adds to your learning hours and your record.',
  },
  journey_assigned: {
    label: 'New learning path assigned',
    group: 'learning',
    icon: 'Map',
    audience: ['learner'],
    email: 'transactional',
    cta: 'View the learning path',
    aspiration: 'A path is a sequence somebody chose — each step unlocks the next.',
  },
  course_completed: {
    label: 'Course completed',
    group: 'learning',
    icon: 'CheckCircle2',
    audience: ['learner'],
    email: 'transactional',
    cta: 'See my progress',
    aspiration: 'That is one more course on your record, and the hours to go with it.',
  },
  course_due_soon: {
    label: 'Course due soon',
    group: 'learning',
    icon: 'CalendarClock',
    audience: ['learner'],
    email: 'transactional',
    cta: 'Continue the course',
    aspiration: 'A short sitting now is easier than a long one on the deadline.',
  },

  /* Self-enrolment opened (0035). TWO types rather than one "something is
     open", because the two are different invitations: a course can be
     started now and a session is a date somebody has to keep free. One
     shared sentence would be wrong for whichever it was not written for —
     the same reason a session already announces to its three audiences in
     three sentences below. */
  course_open_enrolment: {
    label: 'A course is open to join',
    group: 'learning',
    icon: 'BookOpen',
    audience: ['learner'],
    email: 'announcement',
    cta: 'Add to my learning',
    aspiration: 'Nothing is added to your courses until you choose it.',
  },
  session_open_enrolment: {
    label: 'A session is open for booking',
    group: 'sessions',
    icon: 'CalendarPlus',
    audience: ['learner'],
    email: 'announcement',
    cta: 'Book my place',
    aspiration: 'Places are limited and are taken in the order people book.',
  },

  /* ── Recognition ── */
  badge_earned: {
    label: 'Badge earned',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
    email: 'announcement',
    cta: 'See my achievements',
    aspiration: 'Badges recognise consistent work rather than one good day.',
  },
  certificate_issued: {
    label: 'Certificate issued',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
    email: 'transactional',
    cta: 'View my certificate',
    aspiration: 'Yours to download, keep and share — it does not expire.',
  },
  leaderboard_rank: {
    label: 'Leaderboard movement',
    group: 'recognition',
    icon: 'Trophy',
    audience: ['learner'],
    email: 'announcement',
    cta: 'View the leaderboard',
    aspiration: 'Points come from lessons finished and assessments passed.',
  },

  /* ── Sessions ──
     A session touches three audiences at once, which is why each gets its own
     type rather than one type fanned out: the trainer is being given work, the
     learner is being told where to be, and the admin is being told the
     assignment landed. Three sentences, not one. */
  session_assigned_trainer: {
    label: 'You are running a session',
    group: 'sessions',
    icon: 'CalendarCheck',
    audience: ['trainer'],
    email: 'transactional',
    cta: 'View the session',
  },
  session_trainer_set: {
    label: 'Trainer assigned to a session',
    group: 'sessions',
    icon: 'UserCheck',
    audience: ['admin', 'learner'],
    email: 'transactional',
    cta: 'View the session',
  },
  session_enrolled: {
    label: 'You are booked on a session',
    group: 'sessions',
    icon: 'CalendarCheck',
    audience: ['learner'],
    email: 'transactional',
    cta: 'See my sessions',
    aspiration: 'Your trainer marks attendance — that is what credits the training.',
  },
  session_cancelled: {
    label: 'Session cancelled',
    group: 'sessions',
    icon: 'CalendarX',
    audience: ['learner', 'trainer'],
    email: 'transactional',
    cta: 'See my sessions',
  },
  /* The one notification in this catalogue that must carry NO actor. Every
     other type names who caused it; naming the author here would undo the
     anonymity the feedback form promises the learner (0032). */
  session_feedback_received: {
    label: 'New session feedback',
    group: 'sessions',
    icon: 'MessageSquare',
    audience: ['trainer'],
    email: 'transactional',
    cta: 'Read the feedback',
    aspiration: 'Feedback is anonymous: three ratings, never a name.',
  },

  /* Course feedback (0034). The learner IS named, unlike
     `session_feedback_received` above — the owner's rule is "anonymous to
     everyone except the admin", and an admin is exactly who this goes to.
     Only the FIRST submission notifies; revising an answer must not ring a
     bell again. */
  course_feedback_received: {
    label: 'New course feedback',
    group: 'learning',
    icon: 'MessageSquare',
    audience: ['admin'],
    email: 'transactional',
    cta: 'Read the feedback',
  },

  /* External certifications (0036). Four types because four different
     people are being told four different things — the manager is being
     asked to confirm something they should know, L&D is being told a
     decision has reached them, and the learner is being told the outcome.
     §10.18's rule: one shared sentence would be wrong for three of them. */
  external_cert_submitted: {
    label: 'External certification to review',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner', 'admin'],
    email: 'transactional',
    cta: 'Review the claim',
  },
  external_cert_ready: {
    label: 'External certification awaiting final approval',
    group: 'recognition',
    icon: 'Award',
    audience: ['admin'],
    email: 'transactional',
    cta: 'Review the claim',
  },
  external_cert_approved: {
    label: 'External certification approved',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
    email: 'transactional',
    cta: 'See my courses',
    aspiration: 'It now counts towards your learning hours and your completed courses.',
  },
  external_cert_rejected: {
    label: 'External certification not approved',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
    email: 'transactional',
    cta: 'View the details',
  },

  /* ── A manager and their reports ── */
  manager_nudge: {
    label: 'Your manager nudged you',
    group: 'learning',
    icon: 'Bell',
    audience: ['learner'],
    email: 'announcement',
    cta: 'Continue learning',
    aspiration: 'Picking it back up takes less time than starting over.',
  },

  /* ── The admin's org ── */
  learner_onboarded: {
    label: 'Learner onboarded',
    group: 'people',
    icon: 'UserPlus',
    audience: ['admin'],
    email: 'transactional',
    cta: 'Manage users',
  },

  /* ── Commercial, both directions ── */
  service_requested: {
    label: 'Service request raised',
    group: 'commercial',
    icon: 'Sparkles',
    audience: ['admin', 'platform'],
    email: 'transactional',
    cta: 'View the request',
  },
  service_request_answered: {
    label: 'Edstellar replied to your service request',
    group: 'commercial',
    icon: 'Sparkles',
    audience: ['admin'],
    email: 'transactional',
    cta: 'Read the reply',
  },
  seat_requested: {
    label: 'Seat request raised',
    group: 'commercial',
    icon: 'Users',
    audience: ['admin', 'platform'],
    email: 'transactional',
    cta: 'View seat requests',
  },
  seat_request_answered: {
    label: 'Edstellar answered your seat request',
    group: 'commercial',
    icon: 'Users',
    audience: ['admin'],
    email: 'transactional',
    cta: 'View seats',
  },
} as const satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const NOTIFICATION_TYPE_IDS = Object.keys(
  NOTIFICATION_TYPES,
) as NotificationType[];

export function notificationLabel(type: string): string {
  return (
    (NOTIFICATION_TYPES as Record<string, NotificationTypeDef>)[type]?.label ??
    'Notification'
  );
}

/** How many a bell shows before it gives up counting. */
export const UNREAD_BADGE_CAP = 9;

/**
 * "Anita Desai", or their email, or "Edstellar" when there is no actor.
 *
 * One helper rather than the same template literal in eight services: the
 * notification body reads "<somebody> assigned you a course", and a blank
 * there turns a sentence into a fragment. Takes the loose shape every service
 * already has to hand from `@CurrentUser()`.
 */
export function actorLabel(
  actor?: { firstName?: string; lastName?: string; email?: string } | null,
): string {
  if (!actor) return 'Edstellar';
  const name = `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim();
  return name || actor.email || 'Edstellar';
}
