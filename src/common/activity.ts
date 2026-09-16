/**
 * The activity catalogue — what can appear in the admin dashboard's Recent
 * Activity panel.
 *
 * CODE, not data, for the third time in this codebase (`permissions.ts`,
 * `badges.ts`, `workforce.ts`) and for the same reason each time: a type
 * string means something only because a writer emits it and the UI knows how
 * to render it. A type nobody writes is a legend entry for an event that can
 * never happen.
 *
 * `group` is what the panel prints down the right-hand side and what colours
 * the row's icon. It is deliberately coarse — five groups, not one per type —
 * because the panel is scanned, not read.
 */

export const ACTIVITY_TYPES = {
  user_created: { label: 'User created', group: 'users' },
  user_updated: { label: 'User updated', group: 'users' },
  user_deactivated: { label: 'User deactivated', group: 'users' },
  user_reactivated: { label: 'User reactivated', group: 'users' },

  course_created: { label: 'Course created', group: 'content' },
  course_updated: { label: 'Course updated', group: 'content' },
  course_published: { label: 'Course published', group: 'content' },
  course_deleted: { label: 'Course deleted', group: 'content' },
  assessment_created: { label: 'Assessment created', group: 'content' },

  learning_assigned: { label: 'Learning assigned', group: 'assign' },
  journey_assigned: { label: 'Journey assigned', group: 'assign' },

  session_created: { label: 'Session created', group: 'sessions' },
  session_completed: { label: 'Session completed', group: 'sessions' },
  attendance_marked: { label: 'Attendance marked', group: 'sessions' },

  certificate_issued: { label: 'Certificate issued', group: 'recognition' },
  certificate_revoked: { label: 'Certificate revoked', group: 'recognition' },

  service_requested: { label: 'Edstellar service requested', group: 'services' },
} as const;

export type ActivityType = keyof typeof ACTIVITY_TYPES;

/** The six groups, in the order the UI legends them. */
export const ACTIVITY_GROUPS = [
  'users',
  'content',
  'assign',
  'sessions',
  'recognition',
  'services',
] as const;

export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

export function activityLabel(type: string): string {
  return (
    (ACTIVITY_TYPES as Record<string, { label: string }>)[type]?.label ?? type
  );
}

export function activityGroup(type: string): ActivityGroup {
  return (
    (ACTIVITY_TYPES as Record<string, { group: ActivityGroup }>)[type]?.group ??
    'content'
  );
}
