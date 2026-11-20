/**
 * Seeds a self-contained AI-Insights DEMO into ONE organization: a varied course
 * catalogue AND eight learners with coherent, varied learning histories, so the
 * AI coach, admin briefing, Learning Intelligence and every chart have real,
 * differentiated data to work on. Owner request 2026-11-20.
 *
 * WHY IT ALSO CREATES COURSES. The target tenant had only two courses with
 * lessons, so every learner collapsed to the same two and nothing was varied.
 * This script adds a 12-course catalogue across categories (some mandatory, some
 * with assessments, each mapped to skills) so histories can actually differ.
 *
 * WHAT IT CREATES, all in ONE organization:
 *   - ~12 demo courses (module + document lessons; ~half with a real MCQ
 *     assessment; each mapped to a few skills from the existing catalogue).
 *   - 8 learners, each a different job role / level / department, known password.
 *   - assignments in every state: completed, in progress, not started, OVERDUE.
 *   - lesson completions (dated), assessment attempts (perfect / top / pass /
 *     FAIL), certificates (after a pass, or an assessment-free completion).
 *   - gained competencies (user_skills) at beginner / intermediate / advanced.
 *   Badges and points are DERIVED on read (not written), so they stay honest.
 *
 * ⚠ ADDITIVE AND MOCK-ONLY for learners: the only learner deletes are scoped to
 * THESE mock users' ids, so a re-run cleanly replaces their data and touches no
 * real learner. Courses are created once and reused (found by name), never
 * deleted. The admin account is never touched.
 *
 *   node scripts/seed-ai-demo.mjs --list-orgs
 *   node scripts/seed-ai-demo.mjs --org=7            (dry run — prints the plan)
 *   node scripts/seed-ai-demo.mjs --org=7 --commit   (apply)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, scryptSync } from 'node:crypto';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');
const orgArg = argv.find((a) => a.startsWith('--org='));
const pwArg = argv.find((a) => a.startsWith('--password='));
const domainArg = argv.find((a) => a.startsWith('--domain='));
const ORG_REF = orgArg ? orgArg.split('=')[1] : 'edstellar';
const PASSWORD = pwArg ? pwArg.split('=')[1] : 'Spectra@demo1';
const EMAIL_DOMAIN = domainArg ? domainArg.split('=')[1] : 'demo.spectralms.com';

const CURRENT_PRIVACY_VERSION = '2026-10-22'; // mirror src/common/consent.ts

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
}
function certCode(courseId, userId) {
  const h = createHash('sha256')
    .update(`${courseId}:${userId}:${randomBytes(8).toString('hex')}`)
    .digest('hex').slice(0, 8).toUpperCase();
  return `EDS-${courseId}-${userId}-${h}`;
}
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRandom(20261120);
const DAY = 86400000;
const TODAY = new Date(); TODAY.setHours(12, 0, 0, 0);
const iso = (d) => d.toISOString();
const dateOnly = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(TODAY.getTime() - n * DAY);
const daysAhead = (n) => new Date(TODAY.getTime() + n * DAY);

// ── The demo course catalogue (created once, reused on re-run) ──────────────
const DEMO_COURSES = [
  { name: 'Effective Communication at Work', category: 'Soft Skills', mandatory: 0, selfEnrol: 1, lessons: 3, assessment: true },
  { name: 'Time Management Essentials', category: 'Soft Skills', mandatory: 0, selfEnrol: 1, lessons: 2, assessment: false },
  { name: 'Introduction to Python for Analysts', category: 'Technical', mandatory: 0, selfEnrol: 0, lessons: 4, assessment: true },
  { name: 'Data Visualisation Fundamentals', category: 'Technical', mandatory: 0, selfEnrol: 1, lessons: 3, assessment: true },
  { name: 'Cloud Computing Basics', category: 'Technical', mandatory: 0, selfEnrol: 0, lessons: 3, assessment: true },
  { name: 'Leading High-Performing Teams', category: 'Leadership', mandatory: 0, selfEnrol: 0, lessons: 3, assessment: true },
  { name: 'Coaching and Feedback Skills', category: 'Leadership', mandatory: 0, selfEnrol: 0, lessons: 2, assessment: false },
  { name: 'Anti-Bribery and Corruption', category: 'Compliance', mandatory: 1, selfEnrol: 0, lessons: 2, assessment: true },
  { name: 'Data Privacy and PDPA Awareness', category: 'Compliance', mandatory: 1, selfEnrol: 0, lessons: 3, assessment: true },
  { name: 'Financial Fundamentals for Managers', category: 'Finance', mandatory: 0, selfEnrol: 0, lessons: 3, assessment: true },
  { name: 'Supply Chain Operations 101', category: 'Operations', mandatory: 0, selfEnrol: 1, lessons: 3, assessment: false },
  { name: 'Diversity, Equity and Inclusion', category: 'HR', mandatory: 0, selfEnrol: 0, lessons: 2, assessment: true },
];

const LEARNERS = [
  { first: 'Aarav', last: 'Mehta', jobRole: 'Senior Software Engineer', jobLevel: 'Senior', dept: 'Engineering', location: 'Bangalore',
    completed: 6, inProgress: 1, overdue: 0, notStarted: 2, scores: [100, 96, 88, 74], skills: 12, topLevel: 'advanced' },
  { first: 'Priya', last: 'Nair', jobRole: 'Marketing Manager', jobLevel: 'Manager', dept: 'Marketing', location: 'Mumbai',
    completed: 3, inProgress: 2, overdue: 1, notStarted: 2, scores: [82, 69], skills: 7, topLevel: 'intermediate' },
  { first: 'Rohan', last: 'Gupta', jobRole: 'Sales Executive', jobLevel: 'Mid', dept: 'Sales', location: 'Delhi NCR',
    completed: 2, inProgress: 1, overdue: 3, notStarted: 1, scores: [58, 52], skills: 3, topLevel: 'beginner' },
  { first: 'Sneha', last: 'Iyer', jobRole: 'HR Associate', jobLevel: 'Junior', dept: 'Human Resources', location: 'Chennai',
    completed: 0, inProgress: 1, overdue: 0, notStarted: 5, scores: [], skills: 1, topLevel: 'beginner' },
  { first: 'Vikram', last: 'Singh', jobRole: 'Operations Analyst', jobLevel: 'Mid', dept: 'Operations', location: 'Pune',
    completed: 2, inProgress: 4, overdue: 1, notStarted: 1, scores: [77, 64], skills: 6, topLevel: 'intermediate' },
  { first: 'Ananya', last: 'Reddy', jobRole: 'Finance Associate', jobLevel: 'Mid', dept: 'Finance', location: 'Hyderabad',
    completed: 4, inProgress: 1, overdue: 0, notStarted: 2, scores: [88, 79, 95], skills: 8, topLevel: 'advanced' },
  { first: 'Karan', last: 'Malhotra', jobRole: 'Product Designer', jobLevel: 'Senior', dept: 'Design', location: 'Remote',
    completed: 5, inProgress: 1, overdue: 0, notStarted: 2, scores: [93, 85, 72, 100], skills: 11, topLevel: 'advanced' },
  { first: 'Divya', last: 'Krishnan', jobRole: 'Data Analyst', jobLevel: 'Mid', dept: 'Analytics', location: 'Kochi',
    completed: 3, inProgress: 0, overdue: 0, notStarted: 2, scores: [98, 90, 83], skills: 9, topLevel: 'advanced' },
];

function levelFor(i, topLevel) {
  const order = ['beginner', 'intermediate', 'advanced'];
  const cap = order.indexOf(topLevel);
  return order[i % (cap + 1)];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

async function main() {
  if (argv.includes('--list-orgs')) {
    const { rows } = await q(
      `SELECT o.id, o.slug, o.name, o.is_platform,
              count(u.*) FILTER (WHERE u.role = 'admin' AND u.is_active = 1) AS admins,
              count(u.*) FILTER (WHERE u.role = 'learner' AND u.is_active = 1) AS learners
         FROM organizations o LEFT JOIN users u ON u.organization_id = o.id
        GROUP BY o.id ORDER BY o.id`);
    console.table(rows);
    await pool.end();
    return;
  }

  const byId = /^\d+$/.test(ORG_REF);
  const { rows: orgRows } = await q(
    `SELECT id, name, slug FROM organizations WHERE ${byId ? 'id = $1' : 'slug = $1'}`,
    [byId ? Number(ORG_REF) : ORG_REF]);
  if (orgRows.length === 0) { console.error(`No organization matching "${ORG_REF}".`); process.exit(1); }
  const org = orgRows[0];
  const ORG = org.id;

  const { rows: roleRows } = await q(
    `SELECT id, portal FROM roles WHERE organization_id = $1 AND key = 'learner'`, [ORG]);
  if (roleRows.length === 0) { console.error(`Org ${ORG} has no learner role.`); process.exit(1); }
  const learnerRole = roleRows[0];

  const { rows: admins } = await q(
    `SELECT id, first_name, last_name FROM users
      WHERE organization_id = $1 AND role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`, [ORG]);
  const admin = admins[0] ?? null;

  const { rows: skillRows } = await q(
    `SELECT id, name, domain FROM skills
      WHERE organization_id IN ($1, (SELECT id FROM organizations WHERE is_platform = true LIMIT 1))
        AND is_active = 1 ORDER BY id`, [ORG]);

  console.log(`\nOrganization ${org.id} — ${org.name} (${org.slug})`);
  console.log(`Admin (untouched): ${admin ? `${admin.first_name} ${admin.last_name} #${admin.id}` : 'none found'}`);
  console.log(`${DEMO_COURSES.length} demo courses · ${skillRows.length} skills available\n`);
  if (skillRows.length === 0) console.warn('⚠ No skills in the catalogue — competency charts will be thin.\n');

  console.log('PLAN — 8 demo learners (admin left as is):\n');
  for (const L of LEARNERS) {
    console.log(`  ${(`${L.first}.${L.last}@${EMAIL_DOMAIN}`).toLowerCase()}`);
    console.log(`     ${L.jobRole} · ${L.jobLevel} · ${L.dept}`);
    console.log(`     target: ${L.completed} completed, ${L.inProgress} in-progress, ${L.overdue} overdue, ${L.notStarted} not-started · ~${L.skills} skills\n`);
  }
  console.log(`Demo courses: ${DEMO_COURSES.map((c) => c.name).join(', ')}`);
  console.log(`Password for all: ${PASSWORD}\n`);

  if (!commit) {
    console.log('DRY RUN — nothing written. Re-run with --commit to apply.\n');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Ensure the demo course catalogue exists (idempotent by name) ──
    const skillIds = skillRows.map((s) => s.id);
    const coursePool = []; // { id, name, category, lessonIds[], assessment:{id,questions}|null }
    let createdCourses = 0;

    for (const [ci, def] of DEMO_COURSES.entries()) {
      const existing = await client.query(
        `SELECT id FROM courses WHERE organization_id = $1 AND name = $2 LIMIT 1`, [ORG, def.name]);
      let courseId;
      if (existing.rows.length > 0) {
        courseId = existing.rows[0].id;
      } else {
        createdCourses++;
        const ins = await client.query(
          `INSERT INTO courses (organization_id, name, description, is_active, category, is_mandatory, self_enrol, feedback_enabled, tags)
           VALUES ($1,$2,$3,1,$4,$5,$6,1,$7) RETURNING id`,
          [ORG, def.name, `${def.name} — a demo course for the AI Insights showcase.`, def.category, def.mandatory, def.selfEnrol, 'demo'],
        );
        courseId = ins.rows[0].id;
        const mod = await client.query(
          `INSERT INTO course_modules (organization_id, course_id, title, sort_order, is_active)
           VALUES ($1,$2,$3,0,1) RETURNING id`, [ORG, courseId, 'Module 1']);
        const moduleId = mod.rows[0].id;
        for (let k = 0; k < def.lessons; k++) {
          await client.query(
            `INSERT INTO lessons (organization_id, module_id, course_id, title, content_type, duration_minutes, sort_order, is_active)
             VALUES ($1,$2,$3,$4,'document',$5,$6,1)`,
            [ORG, moduleId, courseId, `Lesson ${k + 1}`, 20 + ((k + ci) % 4) * 10, k]);
        }
        if (def.assessment) {
          const a = await client.query(
            `INSERT INTO assessments (organization_id, course_id, title, passing_score, link_type, is_active)
             VALUES ($1,$2,$3,70,'course',1) RETURNING id`, [ORG, courseId, `${def.name} — Final Assessment`]);
          const assessmentId = a.rows[0].id;
          for (let qn = 0; qn < 4; qn++) {
            const qrow = await client.query(
              `INSERT INTO assessment_questions (organization_id, assessment_id, question_text, question_type, marks, sort_order)
               VALUES ($1,$2,$3,'mcq',1,$4) RETURNING id`,
              [ORG, assessmentId, `Question ${qn + 1} for ${def.name}?`, qn]);
            const qid = qrow.rows[0].id;
            for (let oi = 0; oi < 4; oi++) {
              await client.query(
                `INSERT INTO assessment_options (organization_id, question_id, option_text, is_correct)
                 VALUES ($1,$2,$3,$4)`, [ORG, qid, `Option ${oi + 1}`, oi === 0 ? 1 : 0]);
            }
          }
        }
        // Map 2-3 skills to the course (deterministic slice), so recommendable
        // courses carry skills — which is what fills the learner's gaps and the
        // admin's skill-intelligence.
        if (skillIds.length > 0) {
          const start = (ci * 2) % skillIds.length;
          const picks = [skillIds[start], skillIds[(start + 1) % skillIds.length], skillIds[(start + 2) % skillIds.length]];
          for (const sid of [...new Set(picks)]) {
            await client.query(
              `INSERT INTO course_skills (course_id, skill_id, level) VALUES ($1,$2,'intermediate')
               ON CONFLICT (course_id, skill_id) DO NOTHING`, [courseId, sid]);
          }
        }
      }
      // Load the (now-existing) lessons + assessment for the history builder.
      const ls = await client.query(
        `SELECT l.id FROM lessons l JOIN course_modules m ON m.id = l.module_id
          WHERE m.course_id = $1 AND l.is_active = 1 ORDER BY l.id`, [courseId]);
      const as = await client.query(
        `SELECT a.id, a.passing_score, (SELECT count(*)::int FROM assessment_questions qq WHERE qq.assessment_id = a.id) AS questions
           FROM assessments a WHERE a.course_id = $1 AND a.is_active = 1 LIMIT 1`, [courseId]);
      coursePool.push({
        id: courseId, name: def.name, category: def.category,
        lessonIds: ls.rows.map((r) => r.id),
        assessment: as.rows[0] ? { id: as.rows[0].id, passing: Number(as.rows[0].passing_score ?? 70), questions: as.rows[0].questions } : null,
      });
    }

    // ── 2. Upsert the learners ──
    const passwordHash = hashPassword(PASSWORD);
    const users = [];
    const mockIds = [];
    for (const [i, L] of LEARNERS.entries()) {
      const email = `${L.first}.${L.last}@${EMAIL_DOMAIN}`.toLowerCase();
      users.push({ email });
      const { rows } = await client.query(
        `INSERT INTO users
           (organization_id, first_name, last_name, email, password, role, role_id,
            department, job_role, job_level, location, is_active, consent_version, consented_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14)
         ON CONFLICT (email) DO UPDATE SET
            first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, password=EXCLUDED.password,
            role=EXCLUDED.role, role_id=EXCLUDED.role_id, department=EXCLUDED.department,
            job_role=EXCLUDED.job_role, job_level=EXCLUDED.job_level, location=EXCLUDED.location,
            organization_id=EXCLUDED.organization_id, is_active=1,
            consent_version=EXCLUDED.consent_version, consented_at=EXCLUDED.consented_at
         RETURNING id`,
        [ORG, L.first, L.last, email, passwordHash, learnerRole.portal, learnerRole.id,
         L.dept, L.jobRole, L.jobLevel, L.location, CURRENT_PRIVACY_VERSION, iso(daysAgo(30)), iso(daysAgo(200 - i * 12))]);
      mockIds.push(rows[0].id);
    }

    // Scoped cleanup — ONLY these mock users.
    await client.query('DELETE FROM user_assessment_answers WHERE attempt_id IN (SELECT id FROM user_assessment_attempts WHERE user_id = ANY($1::int[]))', [mockIds]);
    await client.query('DELETE FROM user_assessment_attempts WHERE user_id = ANY($1::int[])', [mockIds]);
    await client.query('DELETE FROM user_lesson_completions WHERE user_id = ANY($1::int[])', [mockIds]);
    await client.query('DELETE FROM certificates WHERE user_id = ANY($1::int[])', [mockIds]);
    await client.query('DELETE FROM user_skills WHERE user_id = ANY($1::int[])', [mockIds]);
    await client.query('DELETE FROM user_badges WHERE user_id = ANY($1::int[])', [mockIds]);
    await client.query('DELETE FROM user_course_assignments WHERE user_id = ANY($1::int[])', [mockIds]);

    // ── 3. Build and write each learner's history from the course pool ──
    const stats = [];
    for (let i = 0; i < mockIds.length; i++) {
      const uid = mockIds[i];
      const L = LEARNERS[i];
      const shuffled = [...coursePool].sort(() => rand() - 0.5);
      let cur = 0;
      const take = (n) => shuffled.slice(cur, (cur += Math.min(n, Math.max(0, shuffled.length - cur))));
      const buckets = { completed: take(L.completed), inProgress: take(L.inProgress), overdue: take(L.overdue), notStarted: take(L.notStarted) };
      let scoreIdx = 0;
      let passed = 0, failed = 0, certs = 0;

      const assign = (course, assignedAt, dueDate) =>
        client.query(
          `INSERT INTO user_course_assignments (organization_id, user_id, course_id, assigned_by, assigned_at, due_date)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, course_id) DO UPDATE SET assigned_at=EXCLUDED.assigned_at, due_date=EXCLUDED.due_date`,
          [ORG, uid, course.id, admin?.id ?? null, iso(assignedAt), dueDate]);
      const complete = (lessonId, at) =>
        client.query(`INSERT INTO user_lesson_completions (organization_id, user_id, lesson_id, completed_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, lesson_id) DO NOTHING`, [ORG, uid, lessonId, iso(at)]);

      for (const course of buckets.completed) {
        const assignedAt = daysAgo(60 + Math.floor(rand() * 120));
        await assign(course, assignedAt, dateOnly(daysAgo(10)));
        let last = assignedAt;
        for (let k = 0; k < course.lessonIds.length; k++) {
          let at = new Date(assignedAt.getTime() + (k + 1) * (2 + Math.floor(rand() * 5)) * DAY);
          if (at.getTime() > TODAY.getTime()) at = daysAgo(1 + Math.floor(rand() * 20));
          last = at;
          await complete(course.lessonIds[k], at);
        }
        if (course.assessment && course.assessment.questions > 0 && L.scores.length > 0) {
          const pct = L.scores[scoreIdx++ % L.scores.length];
          const ok = pct >= course.assessment.passing;
          const submittedAt = new Date(Math.min(last.getTime() + 2 * DAY, TODAY.getTime()));
          await client.query(
            `INSERT INTO user_assessment_attempts (organization_id, user_id, assessment_id, score, total_questions, percentage, is_passed, submitted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ORG, uid, course.assessment.id, Math.round((pct / 100) * course.assessment.questions), course.assessment.questions, pct, ok ? 1 : 0, iso(submittedAt)]);
          ok ? passed++ : failed++;
          if (ok) { await issueCert(client, ORG, uid, course.id, new Date(Math.min(submittedAt.getTime() + DAY, TODAY.getTime())), pct); certs++; }
        } else if (!course.assessment) {
          await issueCert(client, ORG, uid, course.id, new Date(Math.min(last.getTime() + DAY, TODAY.getTime())), null); certs++;
        }
      }
      for (const course of buckets.inProgress) {
        const assignedAt = daysAgo(15 + Math.floor(rand() * 45));
        await assign(course, assignedAt, dateOnly(daysAhead(14 + Math.floor(rand() * 30))));
        const done = Math.max(1, Math.floor(course.lessonIds.length * (0.2 + rand() * 0.5)));
        for (let k = 0; k < done && k < course.lessonIds.length; k++) await complete(course.lessonIds[k], daysAgo(1 + Math.floor(rand() * 14)));
      }
      for (const course of buckets.overdue) {
        const assignedAt = daysAgo(50 + Math.floor(rand() * 40));
        await assign(course, assignedAt, dateOnly(daysAgo(5 + Math.floor(rand() * 25))));
        if (course.lessonIds.length > 1 && rand() < 0.5) await complete(course.lessonIds[0], daysAgo(20 + Math.floor(rand() * 20)));
      }
      for (const course of buckets.notStarted) {
        await assign(course, daysAgo(1 + Math.floor(rand() * 10)), rand() < 0.5 ? dateOnly(daysAhead(20 + Math.floor(rand() * 40))) : null);
      }

      // Competencies: a varied subset of the skill catalogue at mixed levels.
      const skillPick = [...skillIds].sort(() => rand() - 0.5).slice(0, Math.min(L.skills, skillIds.length));
      for (let si = 0; si < skillPick.length; si++) {
        await client.query(
          `INSERT INTO user_skills (organization_id, user_id, skill_id, level, earned_at, last_reinforced_at)
           VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (user_id, skill_id) DO UPDATE SET level=EXCLUDED.level, last_reinforced_at=EXCLUDED.last_reinforced_at`,
          [ORG, uid, skillPick[si], levelFor(si, L.topLevel), iso(daysAgo(5 + Math.floor(rand() * 150)))]);
      }
      stats.push({ email: users[i].email, completed: buckets.completed.length, inProgress: buckets.inProgress.length, overdue: buckets.overdue.length, notStarted: buckets.notStarted.length, passed, failed, certs, skills: skillPick.length });
    }

    await client.query('COMMIT');
    console.log(`\n✓ Committed. ${createdCourses} new demo courses, 8 learners.\n`);
    console.log('Per learner (as written):');
    for (const s of stats) console.log(`  ${s.email}  → ${s.completed} done, ${s.inProgress} in-prog, ${s.overdue} overdue, ${s.notStarted} not-started · ${s.passed} passed / ${s.failed} failed · ${s.certs} certs · ${s.skills} skills`);
    console.log('\nSign-in credentials (org ' + ORG + '):');
    for (const u of users) console.log(`  ${u.email}   ${PASSWORD}`);
    console.log('');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n✗ Rolled back:', error.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function issueCert(client, ORG, uid, courseId, issuedAt, finalScore) {
  await client.query(
    `INSERT INTO certificates (organization_id, user_id, course_id, certificate_code, issued_at, final_score, is_revoked)
     VALUES ($1,$2,$3,$4,$5,$6,0)`, [ORG, uid, courseId, certCode(courseId, uid), iso(issuedAt), finalScore]);
}

main().catch(async (error) => { console.error(error); await pool.end(); process.exit(1); });
