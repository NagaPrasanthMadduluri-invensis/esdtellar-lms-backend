/**
 * Backdates and thickens one organization's learning history so the admin
 * Analytics page has a trend to draw.
 *
 * WHY THIS EXISTS. Analytics is a time-series page — Monthly, Quarterly,
 * Half-yearly, Yearly, Multi-year. Before this script the demo organization
 * held four lumpy months with 83% of all lesson completions inside one of
 * them, so every window coarser than Monthly collapsed to a single bar and the
 * page's whole premise was invisible. No amount of frontend work fixes that;
 * the data has to span the periods the page offers.
 *
 * WHAT IT WRITES. Eighteen months ending today, for ONE organization:
 *
 *   users            job_level backfilled, NULL location filled, created_at
 *                    spread so "new learners" has an onboarding curve
 *   assignments      widened to ~70% of (learner x course), assigned_at spread
 *                    across the window with volume growing quarter on quarter
 *   completions      per assignment, following its own assigned_at
 *   attempts         for completed courses that carry an assessment
 *   certificates     for a share of completed courses
 *   sessions         spread across the window, with roster and attendance
 *   activity_log     entries mirroring all of the above, so Recent Activity
 *                    is populated from the first load rather than only after
 *                    an admin has done something
 *
 * ⚠ THIS IS DESTRUCTIVE TO LEARNER PROGRESS IN THE TARGET ORG. Completions,
 * attempts, certificates, rosters and attendance are DELETED and regenerated,
 * because a coherent history cannot be produced by layering new rows on top of
 * incoherent old ones — a completion dated before its own assignment is worse
 * than no history at all. Courses, lessons, assessments, users and their
 * accounts are never touched.
 *
 * Deterministic: a fixed-seed PRNG, so two runs produce identical data and a
 * re-run after a schema change is not a fresh shuffle.
 *
 *   node scripts/seed-history.mjs                 (dry run — prints the plan)
 *   node scripts/seed-history.mjs --commit        (applies it)
 *   node scripts/seed-history.mjs --org=11        (a different organization)
 *   node scripts/seed-history.mjs --months=24     (a longer window)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');
const orgArg = argv.find((a) => a.startsWith('--org='));
const monthsArg = argv.find((a) => a.startsWith('--months='));
const ORG = orgArg ? Number(orgArg.split('=')[1]) : 10;
const MONTHS = monthsArg ? Number(monthsArg.split('=')[1]) : 18;

if (!Number.isInteger(ORG) || ORG <= 0) {
  console.error('--org must be a positive integer');
  process.exit(1);
}
if (!Number.isInteger(MONTHS) || MONTHS < 3 || MONTHS > 60) {
  console.error('--months must be between 3 and 60');
  process.exit(1);
}

// ── The closed lists, mirrored from src/common/workforce.ts ──
// Duplicated rather than imported: this is a .mjs script and that is a .ts
// module behind a path alias. If they drift the DTO rejects what the seed
// wrote, which is a loud failure at the next edit rather than a silent one.
const JOB_LEVELS = ['Executive', 'Manager', 'Senior', 'Mid', 'Junior', 'Intern'];
const LOCATIONS = [
  'Ahmedabad', 'Bangalore', 'Chennai', 'Delhi NCR',
  'Hyderabad', 'Kochi', 'Mumbai', 'Pune', 'Remote',
];

// A realistic pyramid rather than a uniform spread — six Executives out of
// twenty learners would make the "by job level" chart meaningless.
const LEVEL_WEIGHTS = [
  ['Executive', 1], ['Manager', 3], ['Senior', 5],
  ['Mid', 6], ['Junior', 4], ['Intern', 1],
];

// ─────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32). Same seed -> same database, every run.
// ─────────────────────────────────────────────────────────────────────────
function makeRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRandom(20260915);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const DAY = 86400000;
const TODAY = new Date();
TODAY.setHours(12, 0, 0, 0);
const WINDOW_START = new Date(TODAY.getTime() - MONTHS * 30 * DAY);
const iso = (d) => d.toISOString();
const dateOnly = (d) => d.toISOString().slice(0, 10);

/**
 * A point in the window, biased LATE.
 *
 * `Math.pow(u, 0.65)` pushes the distribution toward recent dates, so each
 * quarter carries more activity than the one before it. A uniform spread would
 * draw a flat line, which is a trend chart proving there is no trend — true of
 * the generator, not of anything real, and the least useful thing to look at.
 */
function pointInWindow() {
  const u = Math.pow(rand(), 0.65);
  return new Date(WINDOW_START.getTime() + u * (TODAY.getTime() - WINDOW_START.getTime()));
}

function weightedLevel() {
  const total = LEVEL_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [level, w] of LEVEL_WEIGHTS) {
    if ((r -= w) < 0) return level;
  }
  return 'Mid';
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

const plan = { label: [], counts: {} };
const note = (line) => plan.label.push(line);

async function main() {
  const { rows: orgRows } = await q('SELECT id, name FROM organizations WHERE id = $1', [ORG]);
  if (orgRows.length === 0) {
    console.error(`No organization with id ${ORG}.`);
    process.exit(1);
  }
  const org = orgRows[0];

  const { rows: learners } = await q(
    `SELECT id, first_name, last_name, department, location, job_level
       FROM users WHERE organization_id = $1 AND role = 'learner' ORDER BY id`,
    [ORG],
  );
  const { rows: admins } = await q(
    `SELECT id, first_name, last_name FROM users
      WHERE organization_id = $1 AND role = 'admin' ORDER BY id LIMIT 1`,
    [ORG],
  );
  // Content is org-scoped OR platform-owned (BACKEND_STRUCTURE §3.4), and a
  // learner can be assigned either, so the course pool has to be widened the
  // same way the application widens it.
  const { rows: courses } = await q(
    `SELECT c.id, c.name
       FROM courses c
      WHERE c.organization_id IN ($1, (SELECT id FROM organizations WHERE is_platform = true LIMIT 1))
        AND c.session_id IS NULL
      ORDER BY c.id`,
    [ORG],
  );
  const { rows: lessons } = await q(
    `SELECT l.id, m.course_id
       FROM lessons l
       JOIN course_modules m ON m.id = l.module_id
      WHERE m.course_id = ANY($1::int[])
      ORDER BY m.course_id, l.id`,
    [courses.map((c) => c.id)],
  );
  const { rows: assessments } = await q(
    `SELECT a.id, a.course_id, a.passing_score,
            (SELECT count(*)::int FROM assessment_questions qq WHERE qq.assessment_id = a.id) AS questions
       FROM assessments a
      WHERE a.course_id = ANY($1::int[])`,
    [courses.map((c) => c.id)],
  );

  if (learners.length === 0 || courses.length === 0) {
    console.error(`Organization ${ORG} has ${learners.length} learners and ${courses.length} courses — nothing to seed.`);
    process.exit(1);
  }

  const admin = admins[0] ?? null;
  const adminName = admin ? `${admin.first_name} ${admin.last_name}` : 'System';
  const lessonsByCourse = new Map();
  for (const l of lessons) {
    if (!lessonsByCourse.has(l.course_id)) lessonsByCourse.set(l.course_id, []);
    lessonsByCourse.get(l.course_id).push(l.id);
  }
  const assessmentByCourse = new Map(assessments.map((a) => [a.course_id, a]));
  // A course with no lessons can never be completed, so assigning one would
  // add an enrolment that is permanently 0% and quietly drags every completion
  // rate down. Those are excluded from the pool rather than explained later.
  const usable = courses.filter((c) => (lessonsByCourse.get(c.id) ?? []).length > 0);

  console.log(`\nOrganization ${org.id} — ${org.name}`);
  console.log(`Window: ${dateOnly(WINDOW_START)} .. ${dateOnly(TODAY)} (${MONTHS} months)`);
  console.log(`${learners.length} learners · ${usable.length} usable courses (${courses.length} total) · ${lessons.length} lessons · ${assessments.length} assessments\n`);

  // ── Build the whole plan in memory first, so a dry run can print exactly
  //    what a --commit would write. No statement is issued until the end.
  const profiles = [];
  const onboarding = [];
  const assignmentRows = [];
  const completionRows = [];
  const attemptRows = [];
  const certificateRows = [];
  const activityRows = [];

  // ── 1. Profiles and onboarding dates ──────────────────────────────────
  for (const [i, u] of learners.entries()) {
    const level = weightedLevel();
    const location = u.location ?? pick(LOCATIONS);
    profiles.push({ id: u.id, level, location });

    // Onboarded across the first ~80% of the window, in id order, so the
    // "new learners" series climbs instead of arriving all at once.
    const share = (i + 0.5) / learners.length;
    const created = new Date(
      WINDOW_START.getTime() + share * 0.8 * (TODAY.getTime() - WINDOW_START.getTime()),
    );
    onboarding.push({ id: u.id, created });
    activityRows.push({
      at: created, type: 'user_created',
      title: 'User created',
      detail: `Added ${u.first_name} ${u.last_name} (learner${u.department ? `, ${u.department}` : ''})`,
      subjectType: 'user', subjectId: u.id,
    });
  }
  const createdById = new Map(onboarding.map((o) => [o.id, o.created]));

  // ── 2. Assignments, and everything that follows from one ──────────────
  for (const learner of learners) {
    const joined = createdById.get(learner.id);
    // A learner cannot be assigned a course before their account exists.
    const earliest = joined.getTime();
    const pool_ = [...usable].sort(() => rand() - 0.5);
    const takeN = Math.max(2, Math.round(pool_.length * (0.5 + rand() * 0.4)));

    for (const course of pool_.slice(0, takeN)) {
      let assignedAt = pointInWindow();
      if (assignedAt.getTime() < earliest) {
        assignedAt = new Date(earliest + between(1, 20) * DAY);
      }
      if (assignedAt.getTime() > TODAY.getTime()) continue;
      assignmentRows.push({ userId: learner.id, courseId: course.id, assignedAt });

      const courseLessons = lessonsByCourse.get(course.id) ?? [];
      const roll = rand();
      // 58% finish, 27% are partway, 15% never start. Close enough to the
      // demo organization's real shape that the KPIs do not jump when the
      // seed is applied.
      const outcome = roll < 0.58 ? 'completed' : roll < 0.85 ? 'in-progress' : 'not-started';
      const done =
        outcome === 'completed' ? courseLessons.length
        : outcome === 'in-progress' ? Math.max(1, Math.floor(courseLessons.length * (0.2 + rand() * 0.6)))
        : 0;

      // Completions land between the assignment and up to ten weeks after,
      // never in the future.
      const span = between(3, 70) * DAY;
      let lastCompletion = assignedAt;
      for (let k = 0; k < done; k++) {
        const t = assignedAt.getTime() + ((k + 1) / Math.max(done, 1)) * span;
        if (t > TODAY.getTime()) break;
        const at = new Date(t);
        lastCompletion = at;
        completionRows.push({ userId: learner.id, lessonId: courseLessons[k], completedAt: at });
      }

      if (outcome !== 'completed') continue;

      const assessment = assessmentByCourse.get(course.id);
      if (assessment && assessment.questions > 0) {
        // Scores cluster in the 60s-90s with a tail below the pass mark, so
        // the score-distribution histogram has a shape and the pass rate is
        // not 100%.
        const percentage = Math.min(100, Math.max(35, Math.round(62 + rand() * 38 - (rand() < 0.18 ? 35 : 0))));
        const score = Math.round((percentage / 100) * assessment.questions);
        const submittedAt = new Date(Math.min(lastCompletion.getTime() + between(0, 5) * DAY, TODAY.getTime()));
        attemptRows.push({
          userId: learner.id, assessmentId: assessment.id,
          score, totalQuestions: assessment.questions, percentage,
          isPassed: percentage >= Number(assessment.passing_score ?? 60) ? 1 : 0,
          submittedAt,
        });
        // A certificate follows a PASS, not a completion — issuing one for a
        // failed assessment is the thing CertificatesService.evaluate exists
        // to prevent, and the seed must not contradict it.
        if (percentage >= Number(assessment.passing_score ?? 60) && rand() < 0.75) {
          const issuedAt = new Date(Math.min(submittedAt.getTime() + between(0, 3) * DAY, TODAY.getTime()));
          certificateRows.push({ userId: learner.id, courseId: course.id, issuedAt, finalScore: percentage });
          activityRows.push({
            at: issuedAt, type: 'certificate_issued', title: 'Certificate issued',
            detail: `Issued "${course.name}" to ${learner.first_name} ${learner.last_name}`,
            subjectType: 'certificate', subjectId: null,
          });
        }
      } else if (rand() < 0.35) {
        // No assessment on the course — completion alone earns it.
        const issuedAt = new Date(Math.min(lastCompletion.getTime() + between(0, 4) * DAY, TODAY.getTime()));
        certificateRows.push({ userId: learner.id, courseId: course.id, issuedAt, finalScore: null });
      }
    }
  }

  // One activity entry per assignment BATCH, not per assignment: an admin
  // assigning a course to fifteen people did one thing, and fifteen identical
  // lines would be the whole panel.
  const byMonthCourse = new Map();
  for (const a of assignmentRows) {
    const key = `${a.courseId}:${a.assignedAt.toISOString().slice(0, 7)}`;
    if (!byMonthCourse.has(key)) byMonthCourse.set(key, { courseId: a.courseId, at: a.assignedAt, n: 0 });
    const g = byMonthCourse.get(key);
    g.n++;
    if (a.assignedAt < g.at) g.at = a.assignedAt;
  }
  for (const g of byMonthCourse.values()) {
    const course = usable.find((c) => c.id === g.courseId);
    activityRows.push({
      at: g.at, type: 'learning_assigned', title: 'Learning assigned',
      detail: `Assigned "${course?.name ?? 'a course'}" to ${g.n} learner${g.n === 1 ? '' : 's'}`,
      subjectType: 'course', subjectId: g.courseId,
    });
  }

  // ── 3. Sessions across the window, with roster and attendance ─────────
  const { rows: existingSessions } = await q(
    `SELECT id, title, course_id FROM sessions WHERE organization_id = $1 ORDER BY id`,
    [ORG],
  );
  const sessionPlan = [];
  for (const s of existingSessions) {
    const when = pointInWindow();
    const roster = [...learners].sort(() => rand() - 0.5).slice(0, between(4, Math.min(12, learners.length)));
    sessionPlan.push({
      id: s.id, title: s.title, date: dateOnly(when), at: when,
      roster: roster.map((r) => ({
        userId: r.id,
        // present/late/partial credit the training; absent/excused do not
        // (§10.7). Roughly 80% earn it, which is what makes the attendance
        // report worth looking at.
        status: rand() < 0.72 ? 'present' : rand() < 0.5 ? 'late' : rand() < 0.5 ? 'partial' : rand() < 0.6 ? 'absent' : 'excused',
      })),
    });
    activityRows.push({
      at: when, type: 'session_created', title: 'Session created',
      detail: `Scheduled "${s.title}" for ${dateOnly(when)}`,
      subjectType: 'session', subjectId: s.id,
    });
  }

  // ── Report the plan ───────────────────────────────────────────────────
  const monthsOf = (rows, key) => {
    const set = new Set(rows.map((r) => r[key].toISOString().slice(0, 7)));
    return set.size;
  };
  const histogram = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key].toISOString().slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ');
  };

  console.log('PLAN');
  console.log(`  profiles updated      ${profiles.length}  (job_level + location)`);
  console.log(`  onboarding dates      ${onboarding.length}  spread over ${monthsOf(onboarding, 'created')} months`);
  console.log(`  assignments           ${assignmentRows.length}  over ${monthsOf(assignmentRows, 'assignedAt')} months`);
  console.log(`  lesson completions    ${completionRows.length}  over ${monthsOf(completionRows, 'completedAt')} months`);
  console.log(`  assessment attempts   ${attemptRows.length}  over ${monthsOf(attemptRows, 'submittedAt')} months`);
  console.log(`  certificates          ${certificateRows.length}  over ${monthsOf(certificateRows, 'issuedAt')} months`);
  console.log(`  sessions re-dated     ${sessionPlan.length}  with ${sessionPlan.reduce((a, s) => a + s.roster.length, 0)} attendance rows`);
  console.log(`  activity entries      ${activityRows.length}`);
  console.log(`\n  completions by month:\n    ${histogram(completionRows, 'completedAt')}`);

  if (!commit) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
    console.log('⚠ --commit DELETES this organization\'s completions, attempts, certificates,');
    console.log('  rosters and attendance, then regenerates them from the plan above.\n');
    await pool.end();
    return;
  }

  // ── Apply, in one transaction ─────────────────────────────────────────
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Wipe the progress this run is about to replace. Scoped to the target
    // org every time — a missing predicate here would empty the table.
    await client.query('DELETE FROM user_lesson_completions WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM user_assessment_answers WHERE attempt_id IN (SELECT id FROM user_assessment_attempts WHERE organization_id = $1)', [ORG]);
    await client.query('DELETE FROM user_assessment_attempts WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM certificates WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM session_attendance WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM session_roster WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM user_course_assignments WHERE organization_id = $1', [ORG]);
    await client.query('DELETE FROM activity_log WHERE organization_id = $1', [ORG]);

    // Profiles + onboarding, one statement each via unnest rather than a
    // query per learner (§7.1 applies to scripts too — 20 round trips here,
    // 400 on a real tenant).
    await client.query(
      `UPDATE users u SET job_level = v.level, location = v.loc, created_at = v.created
         FROM (SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::timestamptz[])
                 AS t(id, level, loc, created)) v
        WHERE u.id = v.id AND u.organization_id = $5`,
      [
        profiles.map((p) => p.id),
        profiles.map((p) => p.level),
        profiles.map((p) => p.location),
        onboarding.map((o) => iso(o.created)),
        ORG,
      ],
    );

    await insertMany(client,
      `INSERT INTO user_course_assignments (organization_id, user_id, course_id, assigned_by, assigned_at)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[], $5::timestamptz[])
       ON CONFLICT (user_id, course_id) DO UPDATE SET assigned_at = EXCLUDED.assigned_at`,
      assignmentRows, (batch) => [
        ORG,
        batch.map((r) => r.userId),
        batch.map((r) => r.courseId),
        batch.map(() => admin?.id ?? null),
        batch.map((r) => iso(r.assignedAt)),
      ]);

    await insertMany(client,
      `INSERT INTO user_lesson_completions (organization_id, user_id, lesson_id, completed_at)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::timestamptz[])
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET completed_at = EXCLUDED.completed_at`,
      completionRows, (batch) => [
        ORG,
        batch.map((r) => r.userId),
        batch.map((r) => r.lessonId),
        batch.map((r) => iso(r.completedAt)),
      ]);

    await insertMany(client,
      `INSERT INTO user_assessment_attempts
         (organization_id, user_id, assessment_id, score, total_questions, percentage, is_passed, submitted_at)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[], $5::int[], $6::numeric[], $7::int[], $8::timestamptz[])`,
      attemptRows, (batch) => [
        ORG,
        batch.map((r) => r.userId),
        batch.map((r) => r.assessmentId),
        batch.map((r) => r.score),
        batch.map((r) => r.totalQuestions),
        batch.map((r) => r.percentage),
        batch.map((r) => r.isPassed),
        batch.map((r) => iso(r.submittedAt)),
      ]);

    await insertMany(client,
      `INSERT INTO certificates
         (organization_id, user_id, course_id, certificate_code, issued_at, final_score, is_revoked)
       SELECT $1, * FROM unnest($2::int[], $3::int[], $4::text[], $5::timestamptz[], $6::numeric[], $7::int[])`,
      certificateRows, (batch) => [
        ORG,
        batch.map((r) => r.userId),
        batch.map((r) => r.courseId),
        batch.map((r) => certCode(r.courseId, r.userId)),
        batch.map((r) => iso(r.issuedAt)),
        batch.map((r) => r.finalScore),
        batch.map(() => 0),
      ]);

    for (const s of sessionPlan) {
      await client.query('UPDATE sessions SET date = $1 WHERE id = $2 AND organization_id = $3', [s.date, s.id, ORG]);
      if (s.roster.length === 0) continue;
      await client.query(
        `INSERT INTO session_roster (organization_id, session_id, user_id, enrolled_at)
         SELECT $1, $2, * FROM unnest($3::int[], $4::timestamptz[])
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [ORG, s.id, s.roster.map((r) => r.userId), s.roster.map(() => iso(new Date(s.at.getTime() - 7 * DAY)))],
      );
      await client.query(
        `INSERT INTO session_attendance (organization_id, session_id, user_id, status, marked_by, marked_at)
         SELECT $1, $2, * FROM unnest($3::int[], $4::text[], $5::int[], $6::timestamptz[])
         ON CONFLICT (session_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
        [
          ORG, s.id,
          s.roster.map((r) => r.userId),
          s.roster.map((r) => r.status),
          s.roster.map(() => admin?.id ?? null),
          s.roster.map(() => iso(s.at)),
        ],
      );
    }

    await insertMany(client,
      `INSERT INTO activity_log
         (organization_id, type, title, detail, actor_user_id, actor_name, subject_type, subject_id, created_at)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::int[], $9::timestamptz[])`,
      activityRows, (batch) => [
        ORG,
        batch.map((r) => r.type),
        batch.map((r) => r.title),
        batch.map((r) => r.detail),
        batch.map(() => admin?.id ?? null),
        batch.map(() => adminName),
        batch.map((r) => r.subjectType),
        batch.map((r) => r.subjectId),
        batch.map((r) => iso(r.at)),
      ]);

    await client.query('COMMIT');
    console.log('\n✓ Committed.\n');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n✗ Rolled back:', error.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Chunked multi-row INSERT. Postgres caps a statement at 65535 bound
 * parameters; batching at 1000 rows keeps every column list well under it
 * without dropping to one round trip per row.
 */
async function insertMany(client, sql, rows, toParams, size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    if (batch.length === 0) continue;
    await client.query(sql, toParams(batch));
  }
}

/** Same shape as CertificatesService.generateCode — EDS-<course>-<user>-<hash>. */
function certCode(courseId, userId) {
  const h = createHash('sha256')
    .update(`${courseId}:${userId}:${randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `EDS-${courseId}-${userId}-${h}`;
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
