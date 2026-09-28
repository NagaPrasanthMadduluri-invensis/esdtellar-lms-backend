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
}

export const NOTIFICATION_TYPES = {
  /* ── The learner's own learning ── */
  course_assigned: {
    label: 'New course assigned',
    group: 'learning',
    icon: 'BookOpen',
    audience: ['learner'],
  },
  journey_assigned: {
    label: 'New learning path assigned',
    group: 'learning',
    icon: 'Map',
    audience: ['learner'],
  },
  course_completed: {
    label: 'Course completed',
    group: 'learning',
    icon: 'CheckCircle2',
    audience: ['learner'],
  },
  course_due_soon: {
    label: 'Course due soon',
    group: 'learning',
    icon: 'CalendarClock',
    audience: ['learner'],
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
  },
  session_open_enrolment: {
    label: 'A session is open for booking',
    group: 'sessions',
    icon: 'CalendarPlus',
    audience: ['learner'],
  },

  /* ── Recognition ── */
  badge_earned: {
    label: 'Badge earned',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
  },
  certificate_issued: {
    label: 'Certificate issued',
    group: 'recognition',
    icon: 'Award',
    audience: ['learner'],
  },
  leaderboard_rank: {
    label: 'Leaderboard movement',
    group: 'recognition',
    icon: 'Trophy',
    audience: ['learner'],
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
  },
  session_trainer_set: {
    label: 'Trainer assigned to a session',
    group: 'sessions',
    icon: 'UserCheck',
    audience: ['admin', 'learner'],
  },
  session_enrolled: {
    label: 'You are booked on a session',
    group: 'sessions',
    icon: 'CalendarCheck',
    audience: ['learner'],
  },
  session_cancelled: {
    label: 'Session cancelled',
    group: 'sessions',
    icon: 'CalendarX',
    audience: ['learner', 'trainer'],
  },
  /* The one notification in this catalogue that must carry NO actor. Every
     other type names who caused it; naming the author here would undo the
     anonymity the feedback form promises the learner (0032). */
  session_feedback_received: {
    label: 'New session feedback',
    group: 'sessions',
    icon: 'MessageSquare',
    audience: ['trainer'],
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
  },

  /* ── A manager and their reports ── */
  manager_nudge: {
    label: 'Your manager nudged you',
    group: 'learning',
    icon: 'Bell',
    audience: ['learner'],
  },

  /* ── The admin's org ── */
  learner_onboarded: {
    label: 'Learner onboarded',
    group: 'people',
    icon: 'UserPlus',
    audience: ['admin'],
  },

  /* ── Commercial, both directions ── */
  service_requested: {
    label: 'Service request raised',
    group: 'commercial',
    icon: 'Sparkles',
    audience: ['admin', 'platform'],
  },
  service_request_answered: {
    label: 'Edstellar replied to your service request',
    group: 'commercial',
    icon: 'Sparkles',
    audience: ['admin'],
  },
  seat_requested: {
    label: 'Seat request raised',
    group: 'commercial',
    icon: 'Users',
    audience: ['admin', 'platform'],
  },
  seat_request_answered: {
    label: 'Edstellar answered your seat request',
    group: 'commercial',
    icon: 'Users',
    audience: ['admin'],
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
