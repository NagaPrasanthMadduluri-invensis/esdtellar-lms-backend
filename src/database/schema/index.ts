/**
 * Single barrel for the Drizzle schema. `DatabaseService` is typed against this
 * object, so anything exported here is queryable as `db.select().from(...)`.
 *
 * The tables mirror the live Turso database exactly (they were introspected
 * from the legacy `lib/db/schema.js`). The only additive change this layer
 * introduces is the set of secondary indexes declared alongside each table —
 * see `database/migrations/` for how those are applied safely.
 */
export * from './users.schema';
export * from './courses.schema';
export * from './enrollments.schema';
export * from './assessments.schema';
export * from './sessions.schema';
export * from './scorm.schema';
export * from './certificates.schema';
