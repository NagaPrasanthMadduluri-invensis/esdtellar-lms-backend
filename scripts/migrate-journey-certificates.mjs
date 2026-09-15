/**
 * Journey certificates — the non-additive half of `specs/learning-journeys.md`
 * §3.4. `0015_journeys.sql` already added `certificates.journey_id` (additive,
 * nullable, runs on every boot). This script does the two changes that are
 * NOT safe to run automatically (BACKEND_STRUCTURE.md §6.2):
 *
 *   1. `certificates.course_id` DROP NOT NULL — a journey certificate has no
 *      course.
 *   2. Split the existing UNIQUE(user_id, course_id) into two partial unique
 *      indexes (one per certificate kind) and add a CHECK that exactly one of
 *      `course_id` / `journey_id` is set on every row. That UNIQUE is found by
 *      its definition rather than a fixed name: the baseline migration
 *      declares it unnamed, so Postgres auto-generated
 *      "certificates_user_id_course_id_key" — the Drizzle schema's own name
 *      for it, "certificates_user_course_unique", never actually reached the
 *      live database.
 *
 * It also backfills the nine existing badges (`common/badges.ts`) into
 * `user_badges` for whoever already qualifies — the same "so nobody loses a
 * badge they can see today" backfill `0015_journeys.sql`'s header promises.
 * `BadgesService.syncFor` would catch these up lazily on the learner's next
 * achievements-page view or lesson completion; this makes it immediate for
 * everyone, in one set-based INSERT, not a query per learner.
 *
 * Idempotent and safe to re-run: every step below is guarded (checked before
 * applied), and the whole thing runs in ONE transaction that dry-run mode
 * rolls back at the end instead of committing — so a dry run genuinely
 * exercises every statement, including the pre-flight CHECK-violation guard.
 *
 *   node scripts/migrate-journey-certificates.mjs            (dry run)
 *   node scripts/migrate-journey-certificates.mjs --commit   (applies it)
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

const commit = process.argv.includes('--commit');

/**
 * KEEP IN STEP with `common/badges.ts` — the nine catalogue thresholds this
 * script backfills. This is a plain .mjs script (not compiled from the
 * TypeScript catalogue), the same reason `migrate-rbac.mjs` re-lists
 * `ALL_PERMISSIONS` instead of importing it. The three journey-milestone
 * badges are deliberately NOT backfilled here: no journey has ever been
 * completed before this script exists, so there is nothing to backfill for
 * `journeysCompleted` yet.
 */
const CATALOGUE_BADGES = [
  { key: 'first_steps', metric: 'completed_courses', threshold: 1 },
  { key: 'quick_learner', metric: 'completed_before_due', threshold: 1 },
  { key: 'assessment_topper', metric: 'max_assessment_score', threshold: 90 },
  { key: 'perfectionist', metric: 'max_assessment_score', threshold: 100 },
  { key: 'committed_learner', metric: 'completed_courses', threshold: 3 },
  { key: 'scholar', metric: 'completed_courses', threshold: 5 },
  { key: 'high_flyer', metric: 'points', threshold: 500 },
  { key: 'learning_champion', metric: 'points', threshold: 1000 },
  // `feedback_hero` (feedback_count >= 3) is deliberately absent: no
  // feedback table exists yet, so its stat is always 0 — nobody qualifies.
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const client = await pool.connect();
  try {
    const target = new URL(process.env.DATABASE_URL);
    console.log(`\nTarget: ${target.hostname}:${target.port || 5432}/${target.pathname.slice(1)}`);
    console.log(commit ? 'Mode:   COMMIT\n' : 'Mode:   dry run (rolls back at the end)\n');

    /* ── preflight: 0015_journeys.sql must have run ─────────────────────── */
    const { rows: cols } = await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'certificates'
         AND column_name IN ('journey_id', 'course_id')
    `);
    const { rows: tbls } = await client.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)
    `, [['journeys', 'journey_enrollments', 'user_badges']]);
    const missing = [];
    if (!cols.some((c) => c.column_name === 'journey_id')) missing.push('certificates.journey_id');
    if (!cols.some((c) => c.column_name === 'course_id')) missing.push('certificates.course_id');
    for (const t of ['journeys', 'journey_enrollments', 'user_badges']) {
      if (!tbls.some((r) => r.table_name === t)) missing.push(`table ${t}`);
    }
    if (missing.length > 0) {
      console.error(
        `REFUSING: the additive half is incomplete — missing ${missing.join(', ')}. ` +
          'Start the API once so 0015_journeys.sql is applied, then re-run.',
      );
      process.exitCode = 1;
      return;
    }

    /* ── refuse if the data would violate the new CHECK ─────────────────── */
    const { rows: violators } = await client.query(`
      SELECT id, user_id, course_id, journey_id FROM certificates
       WHERE (course_id IS NULL) = (journey_id IS NULL)
    `);
    if (violators.length > 0) {
      console.error(
        `REFUSING: ${violators.length} certificate row(s) have neither or both of ` +
          'course_id/journey_id set, which the new CHECK forbids:',
      );
      for (const v of violators.slice(0, 20)) {
        console.error(`  id=${v.id} user_id=${v.user_id} course_id=${v.course_id} journey_id=${v.journey_id}`);
      }
      console.error('Fix these rows by hand, then re-run.');
      process.exitCode = 1;
      return;
    }

    /* ── current state (idempotency checks) ─────────────────────────────── */
    const { rows: notNullRows } = await client.query(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'certificates' AND column_name = 'course_id'
    `);
    const courseIdNullable = notNullRows[0]?.is_nullable === 'YES';

    const { rows: oldUniqueRows } = await client.query(`
      -- Named by whatever actually created it, not assumed: the baseline
      -- migration (0000_baseline_schema.sql) declares an unnamed
      -- UNIQUE(user_id, course_id), so Postgres auto-generated
      -- "certificates_user_id_course_id_key" — the Drizzle schema's own name
      -- for it ("certificates_user_course_unique") never actually reached the
      -- live database. Found by definition, not by either name, so this
      -- works regardless of which one is actually present.
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'certificates'
         AND con.contype = 'u'
         AND pg_get_constraintdef(con.oid) = 'UNIQUE (user_id, course_id)'
    `);
    const oldUniqueExists = oldUniqueRows.length > 0;
    const oldUniqueName = oldUniqueRows[0]?.conname;

    const { rows: courseIdxRows } = await client.query(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'certificates_user_course_uniq'
    `);
    const courseIdxExists = courseIdxRows.length > 0;

    const { rows: journeyIdxRows } = await client.query(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'certificates_user_journey_uniq'
    `);
    const journeyIdxExists = journeyIdxRows.length > 0;

    const { rows: checkRows } = await client.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'certificates_course_xor_journey'
    `);
    const checkExists = checkRows.length > 0;

    console.log('Current state:');
    console.log(`  certificates.course_id nullable        : ${courseIdNullable}`);
    console.log(`  old (user_id, course_id) UNIQUE exists  : ${oldUniqueExists}${oldUniqueName ? ` (${oldUniqueName})` : ''}`);
    console.log(`  certificates_user_course_uniq exists    : ${courseIdxExists}`);
    console.log(`  certificates_user_journey_uniq exists   : ${journeyIdxExists}`);
    console.log(`  certificates_course_xor_journey exists  : ${checkExists}\n`);

    if (courseIdNullable && !oldUniqueExists && courseIdxExists && journeyIdxExists && checkExists) {
      console.log('Already fully applied. Proceeding only to (re-)run the badge backfill.');
    }

    await client.query('BEGIN');

    if (!courseIdNullable) {
      await client.query('ALTER TABLE certificates ALTER COLUMN course_id DROP NOT NULL');
      console.log('Dropped NOT NULL on certificates.course_id.');
    }

    if (oldUniqueExists) {
      await client.query(`ALTER TABLE certificates DROP CONSTRAINT "${oldUniqueName}"`);
      console.log(`Dropped ${oldUniqueName}.`);
    }

    if (!courseIdxExists) {
      await client.query(`
        CREATE UNIQUE INDEX certificates_user_course_uniq
          ON certificates (user_id, course_id) WHERE course_id IS NOT NULL
      `);
      console.log('Created certificates_user_course_uniq.');
    }

    if (!journeyIdxExists) {
      await client.query(`
        CREATE UNIQUE INDEX certificates_user_journey_uniq
          ON certificates (user_id, journey_id) WHERE journey_id IS NOT NULL
      `);
      console.log('Created certificates_user_journey_uniq.');
    }

    if (!checkExists) {
      await client.query(`
        ALTER TABLE certificates
          ADD CONSTRAINT certificates_course_xor_journey
          CHECK ((course_id IS NULL) <> (journey_id IS NULL))
      `);
      console.log('Added certificates_course_xor_journey CHECK.');
    }

    /* ── badge backfill: nine catalogue badges, one set-based INSERT ────── */
    /**
     * Map each metric to its COLUMN, and compare against `b.threshold` from
     * the VALUES row — not against a threshold baked into the CASE arm.
     *
     * The first version wrote `WHEN '<metric>' THEN (s.<metric> >= <threshold>)`
     * per badge. CASE returns on its first matching arm, so every badge sharing
     * a metric silently used the FIRST badge's threshold: `scholar` (5 courses)
     * and `committed_learner` (3) both tested `>= 1`, `learning_champion`
     * (1000 points) tested `>= 500`, and `perfectionist` (100%) tested `>= 90`.
     * It awarded 27 badges nobody had earned.
     */
    const badgeCases = [...new Set(CATALOGUE_BADGES.map((b) => b.metric))]
      .map((metric) => `WHEN '${metric}' THEN s.${metric}`)
      .join('\n            ');
    const badgeValues = CATALOGUE_BADGES
      .map((b) => `('${b.key}', '${b.metric}', ${b.threshold})`)
      .join(', ');

    const backfill = await client.query(`
      WITH course_stats AS (
        SELECT a.user_id, a.course_id, a.assigned_at,
          (SELECT COUNT(*) FROM lessons l
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id AND l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
          (SELECT COUNT(*) FROM user_lesson_completions ulc
             JOIN lessons l ON l.id = ulc.lesson_id
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id AND ulc.user_id = a.user_id
              AND l.is_active = 1 AND cm.is_active = 1) AS completed_lessons,
          (SELECT MAX(ulc.completed_at) FROM user_lesson_completions ulc
             JOIN lessons l ON l.id = ulc.lesson_id
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id AND ulc.user_id = a.user_id) AS last_activity
        FROM user_course_assignments a
      ),
      stats AS (
        SELECT u.id AS user_id, u.organization_id,
          COUNT(*) FILTER (WHERE cs.total_lessons > 0
            AND cs.completed_lessons >= cs.total_lessons) AS completed_courses,
          COUNT(*) FILTER (WHERE cs.total_lessons > 0
            AND cs.completed_lessons >= cs.total_lessons
            AND cs.last_activity IS NOT NULL
            AND cs.last_activity::date <= (cs.assigned_at::date + 44)) AS completed_before_due,
          COALESCE((SELECT MAX(t.percentage) FROM user_assessment_attempts t
                     WHERE t.user_id = u.id), 0) AS max_assessment_score,
          COALESCE((SELECT COUNT(*) FROM user_lesson_completions c WHERE c.user_id = u.id), 0)
            * 10
          + COALESCE((SELECT COUNT(DISTINCT t.assessment_id) FROM user_assessment_attempts t
                       WHERE t.user_id = u.id AND t.is_passed = 1), 0) * 50 AS points
        FROM users u
        LEFT JOIN course_stats cs ON cs.user_id = u.id
        WHERE u.role = 'learner'
        GROUP BY u.id, u.organization_id
      ),
      badges (badge_key, metric, threshold) AS (
        VALUES ${badgeValues}
      ),
      earned AS (
        SELECT s.organization_id, s.user_id, b.badge_key
        FROM stats s
        CROSS JOIN badges b
        WHERE (CASE b.metric
            ${badgeCases}
          END) >= b.threshold
      )
      INSERT INTO user_badges (organization_id, user_id, badge_key, journey_id, earned_at)
      SELECT organization_id, user_id, badge_key, NULL, now() FROM earned
      ON CONFLICT (user_id, badge_key) DO NOTHING
      RETURNING badge_key
    `);

    const counts = backfill.rows.reduce((acc, r) => {
      acc[r.badge_key] = (acc[r.badge_key] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`\nBadge backfill: ${backfill.rowCount} new award(s).`);
    for (const [key, n] of Object.entries(counts)) console.log(`  ${key}: ${n}`);

    /* ── verify ──────────────────────────────────────────────────────────── */
    const { rows: verify } = await client.query(`
      SELECT
        (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'certificates'
            AND column_name = 'course_id') AS course_id_nullable,
        -- Match on the DEFINITION, not the Drizzle-side name: the live
        -- constraint was auto-named by Postgres, so a name check here could
        -- never fail and verified nothing.
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = 'certificates'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, course_id)') AS old_unique_count,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE indexname = 'certificates_user_course_uniq') AS course_idx_count,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE indexname = 'certificates_user_journey_uniq') AS journey_idx_count,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conname = 'certificates_course_xor_journey') AS check_count
    `);
    const v = verify[0];
    const ok =
      v.course_id_nullable === 'YES' &&
      v.old_unique_count === 0 &&
      v.course_idx_count === 1 &&
      v.journey_idx_count === 1 &&
      v.check_count === 1;

    if (!ok) {
      console.error('\nVerification FAILED — rolling back:', v);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }
    console.log('\nVerification passed:', v);

    if (!commit) {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --commit to apply.');
    } else {
      await client.query('COMMIT');
      console.log('\nCOMMITTED. certificates now supports journey certificates.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED — rolled back.', error);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

await main();
await pool.end();
