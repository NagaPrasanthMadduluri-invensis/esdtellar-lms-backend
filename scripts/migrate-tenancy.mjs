/**
 * Multi-tenancy, phase 3: the deliberate backfill + structural-constraint run.
 * Spec: `specs/multi-tenancy.md` §3.3, §3.5, §3.10, §7.1, §7.2.
 *
 * Phase 1 (`0007_organizations.sql`, additive, runs automatically on boot)
 * already created `organizations` and a NULLABLE `organization_id` on all 21
 * tenant-owned tables. This script does everything phase 1 deliberately left
 * out because it is NOT additive and NOT safe to run on every boot
 * (BACKEND_STRUCTURE.md §6.2):
 *
 *   1. Insert the platform organization and the first real organization(s).
 *   2. Backfill every existing row into the first real organization, with
 *      set-based UPDATEs — no loops (§3.3).
 *   3. SET NOT NULL on every organization_id.
 *   4. Add UNIQUE (organization_id, id) on the 8 composite-FK parents.
 *   5. Add the 19 composite FKs (user axis, the answers exception, the
 *      content tree, the session axis) and 21 simple FKs to `organizations`.
 *   6. Verify: no NULLs, no orphans, row counts unchanged. Abort on mismatch.
 *   7. Drop the 5 single-column indexes the new composite ones supersede.
 *
 * Every existing row lands in the FIRST real organization (§3.10) — the
 * platform organization starts empty; global content is promoted into it by
 * hand, later, through the platform API.
 *
 * The whole thing is ONE transaction. In dry-run mode (the default) every
 * statement still runs — backfill, ALTERs, constraints, index drops, and the
 * verification pass — so a dry run genuinely exercises the migration; it just
 * ROLLBACKs at the end instead of committing. The one cosmetic side effect a
 * rollback cannot undo is the `organizations_id_seq` advancing past the ids a
 * dry run allocated and then discarded — harmless, but worth knowing about
 * before wondering why the first committed run does not start at id 1.
 *
 *   node scripts/migrate-tenancy.mjs            (dry run — shows what would happen)
 *   node scripts/migrate-tenancy.mjs --commit   (applies it)
 *
 * ORG_NAME picks the name of the first real organization (defaults to
 * "Edstellar"). A second organization, "Invensis Technologies", is created
 * alongside it — see REAL_ORGS below, kept as a small array specifically so
 * more organizations are easy to add here later, before the platform API can
 * create them itself.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const commit = process.argv.includes('--commit');

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The list every future organization gets appended to. Only the first entry
// matters for the backfill (§3.10) — everything existing becomes theirs.
const REAL_ORGS = [{ name: process.env.ORG_NAME || 'Edstellar' }, { name: 'Invensis Technologies' }].map(
  (o) => ({ ...o, slug: slugify(o.name) }),
);

// All 21 tenant-owned tables (§3.3), grouped by how they get their org.
const USER_OWNED_TABLES = [
  'user_course_assignments',
  'user_lesson_completions',
  'lesson_video_progress',
  'user_assessment_attempts',
  'certificates',
  'user_scorm_assignments',
  'scorm_tracking',
  'scorm_attempts',
  'session_roster',
  'session_attendance',
];
const CONTENT_TABLES = [
  'courses',
  'course_modules',
  'lessons',
  'lesson_resources',
  'assessments',
  'assessment_questions',
  'assessment_options',
  'scorm_packages',
];
const ALL_TABLES = [
  'users',
  ...USER_OWNED_TABLES,
  'user_assessment_answers',
  ...CONTENT_TABLES,
  'sessions',
];

// The 8 parents that need UNIQUE (organization_id, id) so a composite FK can
// target them (§3.5).
const COMPOSITE_UNIQUE_PARENTS = [
  'users',
  'user_assessment_attempts',
  'courses',
  'course_modules',
  'lessons',
  'assessments',
  'assessment_questions',
  'sessions',
];

// The 19 composite FKs (§3.5, §7). ON DELETE mirrors each table's existing
// single-column FK so behaviour does not change, only the guarantee widens.
const COMPOSITE_FKS = [
  // User axis (10) — activity dies with the user.
  ...USER_OWNED_TABLES.map((table) => ({
    name: `fk_${table}_org_user`,
    table,
    cols: ['organization_id', 'user_id'],
    refTable: 'users',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  })),
  // The one activity table with no user_id — reaches its org through its
  // attempt (§3.3 exception).
  {
    name: 'fk_user_assessment_answers_org_attempt',
    table: 'user_assessment_answers',
    cols: ['organization_id', 'attempt_id'],
    refTable: 'user_assessment_attempts',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  // Content tree (6).
  {
    name: 'fk_course_modules_org_course',
    table: 'course_modules',
    cols: ['organization_id', 'course_id'],
    refTable: 'courses',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    name: 'fk_lessons_org_module',
    table: 'lessons',
    cols: ['organization_id', 'module_id'],
    refTable: 'course_modules',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    name: 'fk_lesson_resources_org_lesson',
    table: 'lesson_resources',
    cols: ['organization_id', 'lesson_id'],
    refTable: 'lessons',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    name: 'fk_assessments_org_course',
    table: 'assessments',
    cols: ['organization_id', 'course_id'],
    refTable: 'courses',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    name: 'fk_assessment_questions_org_assessment',
    table: 'assessment_questions',
    cols: ['organization_id', 'assessment_id'],
    refTable: 'assessments',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    name: 'fk_assessment_options_org_question',
    table: 'assessment_options',
    cols: ['organization_id', 'question_id'],
    refTable: 'assessment_questions',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
  // Session axis (2) — both columns are nullable already; a NULL column
  // simply exempts that row from enforcement (Postgres MATCH SIMPLE).
  {
    name: 'fk_sessions_org_course',
    table: 'sessions',
    cols: ['organization_id', 'course_id'],
    refTable: 'courses',
    refCols: ['organization_id', 'id'],
    onDelete: 'SET NULL',
  },
  {
    name: 'fk_courses_org_session',
    table: 'courses',
    cols: ['organization_id', 'session_id'],
    refTable: 'sessions',
    refCols: ['organization_id', 'id'],
    onDelete: 'CASCADE',
  },
];

// NOT deriving activity -> content composite FKs (e.g.
// user_lesson_completions.lesson_id, certificates.course_id, *.package_id,
// lessons.scorm_package_id). SQL cannot express "my org OR the platform org",
// and a global course/package legitimately has a different org from the
// activity row referencing it. That axis is service-enforced, not
// FK-enforced (spec §3.5). Do not "complete" this list later.

// The 5 single-column indexes the new composite ones supersede (§3.7, §9).
const SUPERSEDED_INDEXES = [
  'idx_users_role_active',
  'idx_courses_active',
  'idx_sessions_date',
  'idx_users_department',
  'idx_scorm_packages_active',
];

async function constraintExists(client, name, table) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = $1 AND t.relname = $2`,
    [name, table],
  );
  return rows.length > 0;
}

async function ensureConstraint(client, name, table, ddl, log) {
  if (await constraintExists(client, name, table)) {
    log(`  [skip] ${name} (already exists)`);
    return;
  }
  await client.query(ddl);
  log(`  [add]  ${name}`);
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // ---------------------------------------------------------------------
    // 1. Preflight — outside the transaction, read-only.
    // ---------------------------------------------------------------------
    const { rows: tbl } = await client.query(`SELECT to_regclass('public.organizations') AS t`);
    if (!tbl[0].t) {
      console.error(
        'REFUSING: the "organizations" table does not exist. Phase 1 ' +
          '(0007_organizations.sql) has not been applied to this database — ' +
          'start the API once so its boot migration runs, then re-run this script.',
      );
      process.exitCode = 1;
      return;
    }

    const { rows: colRows } = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organization_id'
         AND table_name = ANY($1)`,
      [ALL_TABLES],
    );
    const withColumn = new Set(colRows.map((r) => r.table_name));
    const missing = ALL_TABLES.filter((t) => !withColumn.has(t));
    if (missing.length > 0) {
      console.error(
        `REFUSING: phase 1 is incomplete — these tables have no organization_id ` +
          `column yet: ${missing.join(', ')}. Apply 0007_organizations.sql first.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Preflight OK: organizations table exists; all 21 tables have organization_id.\n');

    const { rows: platformRows } = await client.query(
      `SELECT id, name, slug FROM organizations WHERE is_platform`,
    );
    if (platformRows.length > 0) {
      console.log(
        `REFUSING to run again: a platform organization already exists ` +
          `(id ${platformRows[0].id}, "${platformRows[0].name}"). This migration has ` +
          `already been applied. No changes made.`,
      );
      process.exitCode = 0;
      return;
    }

    // ---------------------------------------------------------------------
    // One transaction from here on.
    // ---------------------------------------------------------------------
    await client.query('BEGIN');

    // 2. Snapshot — the safety net for step 6.
    const before = {};
    for (const table of ALL_TABLES) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
      before[table] = rows[0].c;
    }
    console.log('Snapshot (pre-migration row counts):');
    for (const table of ALL_TABLES) console.log(`  ${String(before[table]).padStart(6)}  ${table}`);

    // 3. Insert organizations.
    console.log('\nCreating organizations:');
    const { rows: platformOrg } = await client.query(
      `INSERT INTO organizations (name, slug, is_platform) VALUES ($1, $2, true) RETURNING id, name, slug`,
      ['Edstellar Platform', '__platform'],
    );
    console.log(`  [${platformOrg[0].id}] ${platformOrg[0].name} (${platformOrg[0].slug}) — platform`);

    const realOrgs = [];
    for (const org of REAL_ORGS) {
      const { rows } = await client.query(
        `INSERT INTO organizations (name, slug, is_platform) VALUES ($1, $2, false) RETURNING id, name, slug`,
        [org.name, org.slug],
      );
      realOrgs.push(rows[0]);
      console.log(`  [${rows[0].id}] ${rows[0].name} (${rows[0].slug})`);
    }
    const firstRealOrgId = realOrgs[0].id;
    console.log(`\nFirst real organization (everything existing lands here): "${realOrgs[0].name}" (id ${firstRealOrgId})`);

    // 4. Backfill — set-based UPDATEs only, in dependency order.
    console.log('\nBackfilling organization_id:');
    const backfillCounts = {};

    // Identity: users -> the first real org.
    {
      const { rowCount } = await client.query(`UPDATE users SET organization_id = $1`, [firstRealOrgId]);
      backfillCounts.users = rowCount;
    }

    // Activity: the org of their user, via user_id.
    for (const table of USER_OWNED_TABLES) {
      const { rowCount } = await client.query(
        `UPDATE "${table}" t SET organization_id = u.organization_id FROM users u WHERE t.user_id = u.id`,
      );
      backfillCounts[table] = rowCount;
    }

    // The exception: user_assessment_answers has no user_id, reaches its org
    // through attempt_id -> user_assessment_attempts (already backfilled above).
    {
      const { rowCount } = await client.query(
        `UPDATE user_assessment_answers a
         SET organization_id = at.organization_id
         FROM user_assessment_attempts at
         WHERE a.attempt_id = at.id`,
      );
      backfillCounts.user_assessment_answers = rowCount;
    }

    // Content: the owner — the first real org (nothing is promoted global yet).
    for (const table of CONTENT_TABLES) {
      const { rowCount } = await client.query(`UPDATE "${table}" SET organization_id = $1`, [firstRealOrgId]);
      backfillCounts[table] = rowCount;
    }

    // Sessions: always a real org, never the platform org.
    {
      const { rowCount } = await client.query(`UPDATE sessions SET organization_id = $1`, [firstRealOrgId]);
      backfillCounts.sessions = rowCount;
    }

    for (const table of ALL_TABLES) console.log(`  ${String(backfillCounts[table]).padStart(6)}  ${table}`);

    // 5. SET NOT NULL on every organization_id.
    console.log('\nSetting organization_id NOT NULL on all 21 tables.');
    for (const table of ALL_TABLES) {
      await client.query(`ALTER TABLE "${table}" ALTER COLUMN organization_id SET NOT NULL`);
    }

    // 6. UNIQUE (organization_id, id) on the 8 composite-FK parents.
    console.log('\nAdding UNIQUE (organization_id, id) parents:');
    for (const table of COMPOSITE_UNIQUE_PARENTS) {
      const name = `${table}_org_id_key`;
      await ensureConstraint(
        client,
        name,
        table,
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" UNIQUE (organization_id, id)`,
        console.log,
      );
    }

    // 7. Composite FKs (the structural, user-axis guarantee — §3.5).
    console.log('\nAdding composite foreign keys:');
    for (const fk of COMPOSITE_FKS) {
      const ddl =
        `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" ` +
        `FOREIGN KEY (${fk.cols.join(', ')}) REFERENCES "${fk.refTable}" (${fk.refCols.join(', ')}) ` +
        `ON DELETE ${fk.onDelete}`;
      await ensureConstraint(client, fk.name, fk.table, ddl, console.log);
    }

    // Simple FKs, organization_id -> organizations(id), on all 21 tables.
    // NOT VALID first, VALIDATE second, to keep the initial lock short
    // (BACKEND_STRUCTURE.md §7.4 / spec instructions).
    console.log('\nAdding organization_id -> organizations(id) foreign keys:');
    for (const table of ALL_TABLES) {
      const name = `fk_${table}_organization`;
      await ensureConstraint(
        client,
        name,
        table,
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (organization_id) REFERENCES organizations (id) NOT VALID`,
        console.log,
      );
      await client.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
    }

    // 8. Verify. Any mismatch aborts the whole transaction.
    console.log('\nVerifying...');
    const problems = [];

    for (const table of ALL_TABLES) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}" WHERE organization_id IS NULL`);
      if (rows[0].c !== 0) problems.push(`${table}: ${rows[0].c} row(s) with NULL organization_id`);
    }

    for (const table of ALL_TABLES) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
      if (rows[0].c !== before[table]) {
        problems.push(`${table}: row count changed (${before[table]} -> ${rows[0].c})`);
      }
    }

    for (const table of ALL_TABLES) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS c FROM "${table}" t
         WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = t.organization_id)`,
      );
      if (rows[0].c !== 0) problems.push(`${table}: ${rows[0].c} row(s) with an organization_id not in organizations`);
    }

    if (problems.length > 0) {
      await client.query('ROLLBACK');
      console.error('\nVERIFICATION FAILED — rolled back, no changes applied:');
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log('  OK: zero NULLs, row counts unchanged, every organization_id resolves.');

    // 9. Index drops — only after verification passes.
    console.log('\nDropping superseded single-column indexes:');
    for (const idx of SUPERSEDED_INDEXES) {
      await client.query(`DROP INDEX IF EXISTS "${idx}"`);
      console.log(`  [drop] ${idx}`);
    }

    // 10. Summary + commit/rollback.
    console.log('\n--- Summary ---');
    console.log(`Organizations created: ${1 + realOrgs.length} (1 platform + ${realOrgs.length} real)`);
    console.log(`Tables backfilled: ${ALL_TABLES.length}`);
    console.log(`UNIQUE (organization_id, id) parents: ${COMPOSITE_UNIQUE_PARENTS.length}`);
    console.log(`Composite FKs: ${COMPOSITE_FKS.length}`);
    console.log(`Simple organization_id -> organizations FKs: ${ALL_TABLES.length}`);
    console.log(`Indexes dropped: ${SUPERSEDED_INDEXES.length}`);

    if (commit) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED. Multi-tenancy backfill is applied.');
    } else {
      await client.query('ROLLBACK');
      console.log(
        '\nDRY RUN — every statement above ran successfully inside a transaction ' +
          'that was then rolled back. No changes were applied. Re-run with --commit to apply.',
      );
    }
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch { /* connection may already be broken */ }
    console.error('\nFAILED — rolled back, no changes applied.');
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
