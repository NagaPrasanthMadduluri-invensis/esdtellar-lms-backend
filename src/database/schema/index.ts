/**
 * Single barrel for the Drizzle schema. `DatabaseService` is typed against this
 * object, so anything exported here is queryable as `db.select().from(...)`.
 *
 * The tables mirror the live Postgres database exactly (they were originally
 * introspected from the legacy `lib/db/schema.js`, then ported from SQLite to
 * PostgreSQL). The only additive change this layer
 * introduces is the set of secondary indexes declared alongside each table —
 * see `database/migrations/` for how those are applied safely.
 */
export * from './organizations.schema';
export * from './users.schema';
export * from './roles.schema';
export * from './courses.schema';
// Depends on courses + users; certificates and enrollments below depend on it
// in turn, so it must be exported here, before either.
export * from './journeys.schema';
export * from './enrollments.schema';
export * from './assessments.schema';
export * from './sessions.schema';
export * from './scorm.schema';
export * from './certificates.schema';
// Depends on users only. Last because nothing depends on it.
export * from './activity.schema';
// Depends on organizations + users. Nothing depends on it.
export * from './services.schema';
// Depends on organizations + users. Nothing depends on it.
export * from './billing.schema';
// Depends on organizations + users. Nothing depends on it.
export * from './seats.schema';

/** Per-recipient notifications with read state (0030). */
export * from './notifications.schema';

/** Session feedback, written by learners and read anonymised by trainers (0032). */
export * from './feedback.schema';

/** Editable course-feedback templates and the answers learners gave (0034). */
export * from './course-feedback.schema';

/** External certifications and their two-step approval trail (0036). */
export * from './external-certifications.schema';

/** The email outbox, suppressions, preferences and reset tokens (0037). */
export * from './email.schema';
