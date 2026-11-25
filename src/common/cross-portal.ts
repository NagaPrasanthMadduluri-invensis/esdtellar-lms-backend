import { PERMISSION_IDS, PERMISSION_PORTALS, type Permission } from './permissions';

/**
 * Who, from OUTSIDE the admin portal, may use an admin route that names no
 * permission of its own: the `@CrossPortal()` lists (BACKEND_STRUCTURE §10.65).
 *
 * Each list is "every permission whose screen needs this read". An
 * admin-portal role is unaffected by them (content reads stay open to it); a
 * Learner, Manager or Trainer role given one of these as an extra gets the
 * read its screen needs, and a role given none still gets 403.
 */

/** The course list and one course: every screen that picks or shows a course. */
export const COURSE_READERS: Permission[] = [
  'manage_courses',
  'upload_content',
  'build_assessments',
  'manage_assessments',
  'assign_learning',
  'manage_sessions',
  'manage_journeys',
  'manage_certificates',
];

/** A course's insides (modules, lessons, media, assessments, preview). */
export const CONTENT_READERS: Permission[] = [
  'manage_courses',
  'upload_content',
  'build_assessments',
  'manage_assessments',
];

/** Who is assigned to a course. */
export const ASSIGNMENT_READERS: Permission[] = ['manage_courses', 'assign_learning'];

export const JOURNEY_READERS: Permission[] = ['manage_journeys', 'assign_learning', 'manage_courses'];

export const SESSION_READERS: Permission[] = [
  'manage_sessions',
  'complete_session',
  'manage_session_roster',
  'mark_attendance',
];

export const SCORM_READERS: Permission[] = ['upload_content', 'manage_courses', 'assign_learning'];

/** The role list: the roles screen, and the role picker on the user form. */
export const ROLE_READERS: Permission[] = ['manage_roles', 'manage_users', 'edit_employees', 'view_employees'];

/**
 * Every permission an admin route checks. Holding any one of them is what puts
 * somebody in front of an admin screen at all, so the organization's own name,
 * logo and option lists (needed by the shell and the forms) open to them.
 */
export const ADMIN_PORTAL_PERMISSIONS: Permission[] = PERMISSION_IDS.filter((p) =>
  (PERMISSION_PORTALS[p] as readonly string[]).includes('admin'),
);

