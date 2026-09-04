/**
 * Cross-tenant isolation test suite (specs/multi-tenancy.md §7.6).
 *
 * The one place the project's no-tests stance is deliberately overridden: a
 * tenancy leak is silent — nothing throws, nothing 500s, the wrong
 * organization's data simply renders and looks correct. This script drives
 * the ALREADY-RUNNING API at http://localhost:3001 (never starts its own
 * server, never runs `npm run build`) and fails loudly the moment one org
 * can read, list, or write another org's rows.
 *
 * Plain Node, no test framework (none is installed, and none should be
 * added — AGENTS.md / BACKEND_STRUCTURE.md are explicit that this project
 * has no test harness). Run with:
 *
 *   npm run test:isolation
 *
 * Ids are discovered at runtime — from the database for ground truth, from
 * the API for behaviour — never hard-coded, so the suite keeps passing after
 * a reseed. The one exception is the SCORM package_dir UUID given in the
 * task brief, which is explicitly exempted from that rule.
 *
 * Every fixture this script creates (a course, a session, a module, an
 * assessment, three certificates) is torn down in a `finally` block, so a
 * second run starts from the same state as the first.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';

/* ── .env, loaded the same way scripts/reset-to-admin-only.mjs does ──────── */
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const API = `${BASE_URL}/api`;
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'lms_token';

/** Stable across reseeds per the task brief — the one id allowed to be hard-coded. */
const KNOWN_ED_SCORM_DIR = '6f584d73-5275-4ddb-8098-9989aa40bd44';

const RUN_ID = Date.now();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] ?? null;
}
async function many(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function run(sql, params = []) {
  return pool.query(sql, params);
}

/* ── assertion bookkeeping ────────────────────────────────────────────── */

const results = { pass: 0, fail: 0, skip: 0 };
const failureDetails = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n=== ${title} ===`);
}

function check(name, cond, detail) {
  if (cond) {
    results.pass++;
    console.log(`  PASS  ${name}`);
  } else {
    results.fail++;
    failureDetails.push({ section: currentSection, name, detail });
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  results.skip++;
  console.log(`  SKIP  ${name} -- ${reason}`);
}

/* ── HTTP helpers ─────────────────────────────────────────────────────── */

function extractCookie(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jwt = setCookie.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return jwt ? jwt.split(';')[0] : null;
}

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`Fixture login failed for ${email}: HTTP ${res.status}`);
  }
  const cookie = extractCookie(res);
  const body = await res.json();
  return { email, cookie, user: body.user };
}

/** `session` is a login() result, or null/undefined for an anonymous call. */
async function api(session, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session?.cookie) headers.Cookie = session.cookie;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** Raw (non-/api) request, for the /scorm/* static content boundary. */
async function scormGet(pathAndFile, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE_URL}/scorm/${pathAndFile}`, { headers, redirect: 'manual' });
  return { status: res.status };
}

/* ── cleanup registry — LIFO, each entry best-effort ─────────────────── */

const cleanupTasks = [];
function registerCleanup(label, fn) {
  cleanupTasks.push({ label, fn });
}
async function runCleanup() {
  console.log('\n=== Teardown ===');
  for (const { label, fn } of cleanupTasks.reverse()) {
    try {
      await fn();
      console.log(`  cleaned up: ${label}`);
    } catch (error) {
      console.log(`  CLEANUP FAILED: ${label} -- ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  /* ---- accounts ---- */
  const platformAdmin = await login('superadmin@edstellar.com', 'Platform@123');
  const edAdmin = await login('admin@edstellar.com', 'Admin@123');
  const edLearner = await login('sneha.k@edstellar.com', 'Learner@123');
  const invAdmin = await login('admin@invensis.com', 'Invensis@123');
  const invLearner = await login('ravi.m@invensis.com', 'Learner@123');

  /* ---- ground-truth discovery (DB) ---- */
  const platformOrg = await one('SELECT id FROM organizations WHERE is_platform = true');
  const edOrg = await one("SELECT id FROM organizations WHERE slug = 'edstellar'");
  const invOrg = await one("SELECT id FROM organizations WHERE slug = 'invensis-technologies'");
  if (!platformOrg || !edOrg || !invOrg) {
    throw new Error('Fixture organizations not found — cannot run the isolation suite.');
  }

  const edLearnerRow = await one("SELECT id FROM users WHERE email = 'sneha.k@edstellar.com'");
  const invLearnerRow = await one("SELECT id FROM users WHERE email = 'ravi.m@invensis.com'");

  const edCourseRow = await one(
    'SELECT id, name FROM courses WHERE organization_id = $1 ORDER BY id LIMIT 1',
    [edOrg.id],
  );
  const edCourse2Row = await one(
    'SELECT id FROM courses WHERE organization_id = $1 AND id != $2 ORDER BY id LIMIT 1',
    [edOrg.id, edCourseRow?.id ?? 0],
  );
  const globalCourseRow = await one(
    'SELECT id, name FROM courses WHERE organization_id = $1 ORDER BY id LIMIT 1',
    [platformOrg.id],
  );
  const edSessionRow = await one(
    'SELECT id FROM sessions WHERE organization_id = $1 ORDER BY id LIMIT 1',
    [edOrg.id],
  );
  const edAssessmentRow = await one(
    'SELECT id FROM assessments WHERE organization_id = $1 ORDER BY id LIMIT 1',
    [edOrg.id],
  );
  const edScormRow =
    (await one('SELECT id, package_dir FROM scorm_packages WHERE package_dir = $1', [KNOWN_ED_SCORM_DIR])) ??
    (await one('SELECT id, package_dir FROM scorm_packages WHERE organization_id = $1 LIMIT 1', [edOrg.id]));

  if (!edCourseRow || !globalCourseRow || !edSessionRow || !edAssessmentRow || !edLearnerRow || !invLearnerRow) {
    throw new Error(
      'A required Edstellar/global fixture is missing (course, global course, session, assessment, or the two seeded learners) — cannot run the isolation suite.',
    );
  }

  /* ---- row counts, before any fixture is created (for the residue check) ---- */
  const countsBefore = await tableCounts();

  /* ---- fixture setup: give Invensis something to be read cross-tenant, and
     give both orgs enough certificates that a list-count comparison is real
     rather than "both empty". Every id here is torn down in `finally`. ---- */

  const invCourseCreate = await api(invAdmin, 'POST', '/admin/courses', {
    name: `Isolation Suite Course (Invensis) ${RUN_ID}`,
  });
  if (invCourseCreate.status !== 201) {
    throw new Error(`Fixture setup: creating the Invensis course failed (${invCourseCreate.status})`);
  }
  const invCourseId = invCourseCreate.body.course.id;
  registerCleanup('Invensis fixture course', () => api(invAdmin, 'DELETE', `/admin/courses/${invCourseId}`));

  const invModuleCreate = await api(invAdmin, 'POST', `/admin/courses/${invCourseId}/modules`, {
    title: 'Isolation module',
  });
  if (invModuleCreate.status !== 201) {
    throw new Error(`Fixture setup: creating the Invensis module failed (${invModuleCreate.status})`);
  }
  const invModuleId = invModuleCreate.body.module.id;
  // No separate cleanup: cascades away when invCourseId is deleted (0000_baseline_schema.sql).

  const invAssessmentCreate = await api(invAdmin, 'POST', `/admin/courses/${invCourseId}/assessments`, {
    title: 'Isolation assessment',
  });
  if (invAssessmentCreate.status !== 201) {
    throw new Error(`Fixture setup: creating the Invensis assessment failed (${invAssessmentCreate.status})`);
  }
  const invAssessmentId = invAssessmentCreate.body.assessment.id;
  // No separate cleanup: cascades away with invCourseId too.

  const today = new Date().toISOString().slice(0, 10);
  const invSessionCreate = await api(invAdmin, 'POST', '/admin/sessions', {
    title: `Isolation Suite Session (Invensis) ${RUN_ID}`,
    trainer: 'Isolation QA',
    venue_url: 'https://example.com/meet/isolation',
    date: today,
    start_time: '10:00',
    end_time: '11:00',
  });
  if (invSessionCreate.status !== 201) {
    throw new Error(`Fixture setup: creating the Invensis session failed (${invSessionCreate.status})`);
  }
  const invSessionId = invSessionCreate.body.session.id;
  registerCleanup('Invensis fixture session (cascades its companion course)', () =>
    api(invAdmin, 'DELETE', `/admin/sessions/${invSessionId}`),
  );

  const edCert1Create = await api(edAdmin, 'POST', '/admin/certificates', {
    userId: edLearnerRow.id,
    courseId: edCourseRow.id,
  });
  if (edCert1Create.status !== 201) {
    throw new Error(`Fixture setup: issuing the first Edstellar certificate failed (${edCert1Create.status})`);
  }
  const edCert1Id = edCert1Create.body.certificate.id;

  let edCert2Id = null;
  if (edCourse2Row) {
    const edCert2Create = await api(edAdmin, 'POST', '/admin/certificates', {
      userId: edLearnerRow.id,
      courseId: edCourse2Row.id,
    });
    if (edCert2Create.status !== 201) {
      throw new Error(`Fixture setup: issuing the second Edstellar certificate failed (${edCert2Create.status})`);
    }
    edCert2Id = edCert2Create.body.certificate.id;
  }

  const invCertCreate = await api(invAdmin, 'POST', '/admin/certificates', {
    userId: invLearnerRow.id,
    courseId: invCourseId,
  });
  if (invCertCreate.status !== 201) {
    throw new Error(`Fixture setup: issuing the Invensis certificate failed (${invCertCreate.status})`);
  }
  const invCertId = invCertCreate.body.certificate.id;

  const certIds = [edCert1Id, edCert2Id, invCertId].filter((id) => id !== null);
  registerCleanup('Certificates (no DELETE endpoint exists — revoke is soft, so hard-delete directly)', () =>
    run('DELETE FROM certificates WHERE id = ANY($1)', [certIds]),
  );

  /* ======================================================================
     1. Cross-org reads return 404, never 403, never data
     ====================================================================== */
  section('1. Cross-org reads return 404, never 403, never data');

  const forwardChecks = [
    ['users', 'GET', `/admin/users/${edLearnerRow.id}`],
    ['courses', 'GET', `/admin/courses/${edCourseRow.id}`],
    ['sessions', 'GET', `/admin/sessions/${edSessionRow.id}`],
    ['certificates', 'PATCH', `/admin/certificates/${edCert1Id}`],
    ['assessments', 'GET', `/admin/assessments/${edAssessmentRow.id}`],
  ];
  if (edScormRow) {
    forwardChecks.push(['SCORM packages', 'GET', `/admin/scorm/${edScormRow.id}`]);
  } else {
    skip('SCORM packages (Invensis admin -> Edstellar id)', 'no Edstellar SCORM package fixture found');
  }

  for (const [label, method, path] of forwardChecks) {
    const res = await api(invAdmin, method, path);
    const detail =
      res.status === 403
        ? 'got 403 — this CONFIRMS the resource is visible to a cross-org caller, which is the leak'
        : `expected 404, got ${res.status}`;
    check(`${label}: Invensis admin -> Edstellar id (${method} ${path})`, res.status === 404, detail);
  }

  const reverseChecks = [
    ['users', 'GET', `/admin/users/${invLearnerRow.id}`],
    ['courses', 'GET', `/admin/courses/${invCourseId}`],
    ['sessions', 'GET', `/admin/sessions/${invSessionId}`],
    ['certificates', 'PATCH', `/admin/certificates/${invCertId}`],
    ['assessments', 'GET', `/admin/assessments/${invAssessmentId}`],
  ];
  skip(
    'SCORM packages (Edstellar admin -> Invensis id)',
    'no Invensis-owned SCORM package exists and this suite does not fabricate a zip upload fixture for it',
  );

  for (const [label, method, path] of reverseChecks) {
    const res = await api(edAdmin, method, path);
    const detail =
      res.status === 403
        ? 'got 403 — this CONFIRMS the resource is visible to a cross-org caller, which is the leak'
        : `expected 404, got ${res.status}`;
    check(`${label}: Edstellar admin -> Invensis id (${method} ${path})`, res.status === 404, detail);
  }

  /* ======================================================================
     2. List endpoints never contain another org's rows
     ====================================================================== */
  section('2. List endpoints never contain another org rows');

  // users
  {
    const edLearnerIds = (await many("SELECT id FROM users WHERE organization_id = $1 AND role = 'learner'", [edOrg.id])).map((r) => r.id);
    const invLearnerIds = (await many("SELECT id FROM users WHERE organization_id = $1 AND role = 'learner'", [invOrg.id])).map((r) => r.id);

    const edRes = await api(edAdmin, 'GET', '/admin/users');
    const invRes = await api(invAdmin, 'GET', '/admin/users');
    const edIds = (edRes.body?.users ?? []).map((u) => u.id);
    const invIds = (invRes.body?.users ?? []).map((u) => u.id);

    check('users: Edstellar admin list contains only Edstellar learners', edIds.every((id) => edLearnerIds.includes(id)) && edIds.length > 0);
    check('users: Invensis admin list contains only Invensis learners', invIds.every((id) => invLearnerIds.includes(id)) && invIds.length > 0);
    check('users: Edstellar list does not contain the Invensis learner', !edIds.includes(invLearnerRow.id));
    check('users: Invensis list does not contain the Edstellar learner', !invIds.includes(edLearnerRow.id));
    check('users: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  // courses (content-scoped: own org + platform)
  {
    const edOwnIds = (await many('SELECT id FROM courses WHERE organization_id = $1', [edOrg.id])).map((r) => r.id);
    const invOwnIds = (await many('SELECT id FROM courses WHERE organization_id = $1', [invOrg.id])).map((r) => r.id);
    const platformIds = (await many('SELECT id FROM courses WHERE organization_id = $1', [platformOrg.id])).map((r) => r.id);

    const edRes = await api(edAdmin, 'GET', '/admin/courses');
    const invRes = await api(invAdmin, 'GET', '/admin/courses');
    const edIds = (edRes.body?.courses ?? []).map((c) => c.id);
    const invIds = (invRes.body?.courses ?? []).map((c) => c.id);

    const edAllowed = new Set([...edOwnIds, ...platformIds]);
    const invAllowed = new Set([...invOwnIds, ...platformIds]);

    check('courses: Edstellar admin list is within (own org + platform)', edIds.every((id) => edAllowed.has(id)) && edIds.length > 0);
    check('courses: Invensis admin list is within (own org + platform)', invIds.every((id) => invAllowed.has(id)) && invIds.length > 0);
    check('courses: Edstellar list does not contain the Invensis fixture course', !edIds.includes(invCourseId));
    check('courses: Invensis list does not contain any Edstellar-private course', !invIds.some((id) => edOwnIds.includes(id)));
    check('courses: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  // sessions (org-scoped only — never global)
  {
    const edSessionIds = (await many('SELECT id FROM sessions WHERE organization_id = $1', [edOrg.id])).map((r) => r.id);
    const invSessionIds = (await many('SELECT id FROM sessions WHERE organization_id = $1', [invOrg.id])).map((r) => r.id);

    const edRes = await api(edAdmin, 'GET', '/admin/sessions');
    const invRes = await api(invAdmin, 'GET', '/admin/sessions');
    const edIds = (edRes.body?.sessions ?? []).map((s) => s.id);
    const invIds = (invRes.body?.sessions ?? []).map((s) => s.id);

    check('sessions: Edstellar admin list is exactly Edstellar sessions', edIds.every((id) => edSessionIds.includes(id)) && edIds.length > 0);
    check('sessions: Invensis admin list is exactly Invensis sessions', invIds.every((id) => invSessionIds.includes(id)) && invIds.length > 0);
    check('sessions: Edstellar list does not contain the Invensis fixture session', !edIds.includes(invSessionId));
    check('sessions: Invensis list does not contain any Edstellar session', !invIds.some((id) => edSessionIds.includes(id)));
    check('sessions: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  // certificates (org-scoped only)
  {
    const edRes = await api(edAdmin, 'GET', '/admin/certificates');
    const invRes = await api(invAdmin, 'GET', '/admin/certificates');
    const edIds = (edRes.body?.certificates ?? []).map((c) => c.id);
    const invIds = (invRes.body?.certificates ?? []).map((c) => c.id);

    check('certificates: Edstellar admin list contains both Edstellar fixtures', edIds.includes(edCert1Id) && (edCert2Id === null || edIds.includes(edCert2Id)));
    check('certificates: Invensis admin list contains the Invensis fixture', invIds.includes(invCertId));
    check('certificates: Edstellar list does not contain the Invensis certificate', !edIds.includes(invCertId));
    check('certificates: Invensis list does not contain either Edstellar certificate', !invIds.includes(edCert1Id) && (edCert2Id === null || !invIds.includes(edCert2Id)));
    check('certificates: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  // assessments (content-scoped)
  {
    const edOwnIds = (await many('SELECT id FROM assessments WHERE organization_id = $1', [edOrg.id])).map((r) => r.id);
    const invOwnIds = (await many('SELECT id FROM assessments WHERE organization_id = $1', [invOrg.id])).map((r) => r.id);

    const edRes = await api(edAdmin, 'GET', '/admin/all-assessments');
    const invRes = await api(invAdmin, 'GET', '/admin/all-assessments');
    const edIds = (edRes.body?.assessments ?? []).map((a) => a.id);
    const invIds = (invRes.body?.assessments ?? []).map((a) => a.id);

    check('assessments: Edstellar admin list is within own org (+ platform)', edIds.every((id) => edOwnIds.includes(id)) && edIds.length > 0);
    check('assessments: Invensis admin list is within own org (+ platform)', invIds.every((id) => invOwnIds.includes(id)) && invIds.length > 0);
    check('assessments: Edstellar list does not contain the Invensis fixture assessment', !edIds.includes(invAssessmentId));
    check('assessments: Invensis list does not contain any Edstellar assessment', !invIds.some((id) => edOwnIds.includes(id)));
    check('assessments: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  // scorm packages (content-scoped)
  {
    const edOwnIds = (await many('SELECT id FROM scorm_packages WHERE organization_id = $1', [edOrg.id])).map((r) => r.id);

    const edRes = await api(edAdmin, 'GET', '/admin/scorm');
    const invRes = await api(invAdmin, 'GET', '/admin/scorm');
    const edIds = (edRes.body?.packages ?? []).map((p) => p.id);
    const invIds = (invRes.body?.packages ?? []).map((p) => p.id);

    check('scorm: Edstellar admin list contains the Edstellar package', edScormRow ? edIds.includes(edScormRow.id) : edIds.every((id) => edOwnIds.includes(id)));
    check('scorm: Invensis admin list does not contain the Edstellar package', edScormRow ? !invIds.includes(edScormRow.id) : true);
    check('scorm: list counts genuinely differ between orgs', edIds.length !== invIds.length, `ed=${edIds.length} inv=${invIds.length}`);
  }

  /* ======================================================================
     3. Learner isolation
     ====================================================================== */
  section('3. Learner isolation (ravi.m, sole Invensis learner)');

  {
    const edLearnerIds = (await many("SELECT id FROM users WHERE organization_id = $1 AND role = 'learner'", [edOrg.id])).map((r) => r.id);
    const edOwnCourseIds = (await many('SELECT id FROM courses WHERE organization_id = $1', [edOrg.id])).map((r) => r.id);

    const lbRes = await api(invLearner, 'GET', '/learner/leaderboard');
    const lbIds = (lbRes.body?.allLearners ?? []).map((l) => l.id);
    check('leaderboard: response succeeds for ravi.m', lbRes.status === 200, `status=${lbRes.status}`);
    check('leaderboard: does not contain any Edstellar learner', !lbIds.some((id) => edLearnerIds.includes(id)));
    check('leaderboard: contains ravi.m himself', lbIds.includes(invLearnerRow.id));

    const coursesRes = await api(invLearner, 'GET', '/learner/courses');
    const courseIds = (coursesRes.body?.courses ?? []).map((c) => c.course.id);
    check('learner courses: response succeeds for ravi.m', coursesRes.status === 200, `status=${coursesRes.status}`);
    check('learner courses: does not contain any Edstellar-private course', !courseIds.some((id) => edOwnCourseIds.includes(id)));
    check(
      'learner courses: contains the platform-owned global course (assigned fixture)',
      courseIds.includes(globalCourseRow.id),
      `expected ${globalCourseRow.id} in [${courseIds.join(', ')}]`,
    );
  }

  /* ======================================================================
     4. Global content
     ====================================================================== */
  section('4. Global content — visible to all, editable by none but the platform');

  {
    const edGet = await api(edAdmin, 'GET', `/admin/courses/${globalCourseRow.id}`);
    const invGet = await api(invAdmin, 'GET', `/admin/courses/${globalCourseRow.id}`);
    check('global course: visible (200) to Edstellar admin', edGet.status === 200, `status=${edGet.status}`);
    check('global course: visible (200) to Invensis admin', invGet.status === 200, `status=${invGet.status}`);

    const edPut = await api(edAdmin, 'PUT', `/admin/courses/${globalCourseRow.id}`, { name: globalCourseRow.name });
    const invPut = await api(invAdmin, 'PUT', `/admin/courses/${globalCourseRow.id}`, { name: globalCourseRow.name });
    check('global course: editing it as Edstellar admin is 422', edPut.status === 422, `status=${edPut.status}`);
    check('global course: editing it as Invensis admin is 422', invPut.status === 422, `status=${invPut.status}`);

    const invEditsEdCourse = await api(invAdmin, 'PUT', `/admin/courses/${edCourseRow.id}`, { name: 'hijacked' });
    const edEditsInvCourse = await api(edAdmin, 'PUT', `/admin/courses/${invCourseId}`, { name: 'hijacked' });
    check('private course: Invensis admin editing an Edstellar course is 404', invEditsEdCourse.status === 404, `status=${invEditsEdCourse.status}`);
    check('private course: Edstellar admin editing an Invensis course is 404', edEditsInvCourse.status === 404, `status=${edEditsInvCourse.status}`);
  }

  /* ======================================================================
     5. Body-supplied ids cannot cross tenants
     ====================================================================== */
  section('5. Body-supplied ids cannot cross tenants');

  if (edScormRow) {
    const lessonRes = await api(invAdmin, 'POST', `/admin/modules/${invModuleId}/lessons`, {
      title: 'Cross-tenant SCORM lesson attempt',
      content_type: 'scorm',
      scorm_package_id: edScormRow.id,
      duration_minutes: 30,
    });
    check(
      'lesson create: referencing another org SCORM package id is 404 (not 500, not created)',
      lessonRes.status === 404,
      `status=${lessonRes.status} body=${JSON.stringify(lessonRes.body)}`,
    );
  } else {
    skip('lesson create with foreign scorm_package_id', 'no Edstellar SCORM package fixture found');
  }

  {
    const assignRes = await api(invAdmin, 'POST', `/admin/courses/${invCourseId}/assignments`, {
      user_id: edLearnerRow.id,
    });
    check(
      'assignment create: assigning another org learner id is 404 (not 500)',
      assignRes.status === 404,
      `status=${assignRes.status} body=${JSON.stringify(assignRes.body)}`,
    );
  }

  /* ======================================================================
     6. SCORM content boundary
     ====================================================================== */
  section('6. SCORM content boundary (/scorm/*)');

  if (edScormRow) {
    const dir = edScormRow.package_dir;

    const anon = await scormGet(`${dir}/index.html`, null);
    check('scorm content: anonymous is 401', anon.status === 401, `status=${anon.status}`);

    const entitled = await scormGet(`${dir}/index.html`, edLearner.cookie);
    check('scorm content: entitled learner (sneha.k) is 200', entitled.status === 200, `status=${entitled.status}`);

    const foreign = await scormGet(`${dir}/index.html`, invLearner.cookie);
    check('scorm content: learner from the other org is 404', foreign.status === 404, `status=${foreign.status}`);

    const traversal = await scormGet(`${dir}/..%2fother-package/index.html`, edLearner.cookie);
    check(
      'scorm content: path traversal (/<A>/..%2f<B>/) is 404',
      traversal.status === 404,
      `status=${traversal.status}`,
    );
  } else {
    skip('SCORM content boundary (all four checks)', 'no Edstellar SCORM package fixture found');
  }


  /* ======================================================================
     6b. SCORM data-model log (granular runtime tracking)

     The log is an ACTIVITY table, so every read must use orgScope, never
     contentScope. These checks fail loudly if someone widens it: dropping the
     org predicate from listForLearner would make check 4 below return the
     other tenant's rows.
     ====================================================================== */
  section('6b. SCORM data-model log is org-scoped');

  if (edScormRow) {
    const pkgId = edScormRow.id;
    const probeKey = 'cmi.core.lesson_location';
    const probeValue = `isolation-probe-${Date.now()}`;

    const write = await api(edLearner, 'POST', `/learner/scorm/${pkgId}/datamodel`, {
      deltas: [{ element_key: probeKey, element_value: probeValue }],
    });
    check(
      'datamodel: entitled learner can write a delta',
      write.status === 200 && write.body?.tracked === 1,
      `status=${write.status} tracked=${write.body?.tracked}`,
    );

    // The row must carry the writer's OWN org, taken from the JWT — not
    // anything the body could have said.
    const stored = await one(
      'SELECT organization_id, user_id, attempt_number FROM scorm_datamodel_log WHERE element_value = $1',
      [probeValue],
    );
    check(
      'datamodel: row lands in the writer\'s organization',
      stored && stored.organization_id === edOrg.id,
      `organization_id=${stored?.organization_id} expected=${edOrg.id}`,
    );

    // A body-supplied organization_id must be stripped by ValidationPipe's
    // whitelist and never reach the insert.
    const spoofValue = `isolation-spoof-${Date.now()}`;
    const spoof = await api(edLearner, 'POST', `/learner/scorm/${pkgId}/datamodel`, {
      organization_id: invOrg.id,
      user_id: 999999,
      deltas: [{ element_key: probeKey, element_value: spoofValue }],
    });
    const spoofed = await one(
      'SELECT organization_id FROM scorm_datamodel_log WHERE element_value = $1',
      [spoofValue],
    );
    check(
      'datamodel: body-supplied organization_id is ignored',
      spoof.status === 200 && spoofed && spoofed.organization_id === edOrg.id,
      `stored organization_id=${spoofed?.organization_id} attempted=${invOrg.id}`,
    );

    // The other tenant's learner must not be able to write to, or read, this
    // package at all. 404 rather than 403 on purpose — a 403 would confirm the
    // package exists to someone enumerating ids.
    const foreignWrite = await api(invLearner, 'POST', `/learner/scorm/${pkgId}/datamodel`, {
      deltas: [{ element_key: probeKey, element_value: 'should-never-persist' }],
    });
    check(
      'datamodel: learner from the other org cannot write (404)',
      foreignWrite.status === 404,
      `status=${foreignWrite.status}`,
    );
    const leaked = await one(
      'SELECT COUNT(*)::int AS n FROM scorm_datamodel_log WHERE element_value = $1',
      ['should-never-persist'],
    );
    check('datamodel: the refused write persisted nothing', leaked?.n === 0, `rows=${leaked?.n}`);

    const foreignRead = await api(invLearner, 'GET', `/learner/scorm/${pkgId}/datamodel`);
    check(
      'datamodel: learner from the other org cannot read (404)',
      foreignRead.status === 404,
      `status=${foreignRead.status}`,
    );

    // The admin read is scoped too: the Invensis admin must not be able to
    // read an Edstellar learner's timeline on an Edstellar package.
    const foreignAdmin = await api(
      invAdmin,
      'GET',
      `/admin/scorm/${pkgId}/datamodel/${edLearnerRow.id}`,
    );
    check(
      'datamodel: admin from the other org cannot read a foreign timeline (404)',
      foreignAdmin.status === 404,
      `status=${foreignAdmin.status}`,
    );

    const ownAdmin = await api(
      edAdmin,
      'GET',
      `/admin/scorm/${pkgId}/datamodel/${edLearnerRow.id}`,
    );
    check(
      'datamodel: own-org admin CAN read the timeline',
      ownAdmin.status === 200 && Array.isArray(ownAdmin.body?.entries),
      `status=${ownAdmin.status}`,
    );

    // Clean up the probe rows so the residue check below stays meaningful.
    await pool.query('DELETE FROM scorm_datamodel_log WHERE element_value = ANY($1)', [
      [probeValue, spoofValue],
    ]);
  } else {
    skip('SCORM data-model log (all eight checks)', 'no Edstellar SCORM package fixture found');
  }

  /* ======================================================================
     7. Platform routes are platform-only
     ====================================================================== */
  section('7. Platform routes are platform-only');

  const platformRoutes = [
    ['GET', '/platform/organizations'],
    ['GET', `/platform/organizations/${edOrg.id}`],
    ['GET', '/platform/analytics'],
  ];
  for (const [method, path] of platformRoutes) {
    const asPlatform = await api(platformAdmin, method, path);
    const asEdAdmin = await api(edAdmin, method, path);
    const asInvAdmin = await api(invAdmin, method, path);
    const asLearner = await api(invLearner, method, path);
    check(`${method} ${path}: platform admin is 200`, asPlatform.status === 200, `status=${asPlatform.status}`);
    check(`${method} ${path}: Edstellar admin is 403`, asEdAdmin.status === 403, `status=${asEdAdmin.status}`);
    check(`${method} ${path}: Invensis admin is 403`, asInvAdmin.status === 403, `status=${asInvAdmin.status}`);
    check(`${method} ${path}: a learner is 403`, asLearner.status === 403, `status=${asLearner.status}`);
  }

  /* ======================================================================
     8. Writes land in the caller's org
     ====================================================================== */
  section("8. Writes land in the caller's org");

  {
    const edCreate = await api(edAdmin, 'POST', '/admin/courses', { name: `Isolation Suite Writes (Edstellar) ${RUN_ID}` });
    check('course create: Edstellar admin -> 201', edCreate.status === 201, `status=${edCreate.status}`);
    const edOrgIdOnRow = edCreate.body?.course?.organizationId ?? edCreate.body?.course?.organization_id;
    check('course create: lands in the Edstellar org', edOrgIdOnRow === edOrg.id, `got organization_id=${edOrgIdOnRow}, expected ${edOrg.id}`);
    if (edCreate.status === 201) {
      const del = await api(edAdmin, 'DELETE', `/admin/courses/${edCreate.body.course.id}`);
      check('course create: cleanup delete succeeds', del.status === 200, `status=${del.status}`);
    }

    const invCreate = await api(invAdmin, 'POST', '/admin/courses', { name: `Isolation Suite Writes (Invensis) ${RUN_ID}` });
    check('course create: Invensis admin -> 201', invCreate.status === 201, `status=${invCreate.status}`);
    const invOrgIdOnRow = invCreate.body?.course?.organizationId ?? invCreate.body?.course?.organization_id;
    check('course create: lands in the Invensis org', invOrgIdOnRow === invOrg.id, `got organization_id=${invOrgIdOnRow}, expected ${invOrg.id}`);
    if (invCreate.status === 201) {
      const del = await api(invAdmin, 'DELETE', `/admin/courses/${invCreate.body.course.id}`);
      check('course create: cleanup delete succeeds', del.status === 200, `status=${del.status}`);
    }
  }

  return { countsBefore };
}

async function tableCounts() {
  const tables = ['users', 'courses', 'user_course_assignments', 'user_lesson_completions'];
  const out = {};
  for (const t of tables) {
    const row = await one(`SELECT COUNT(*)::int AS n FROM ${t}`);
    out[t] = row.n;
  }
  return out;
}

/* ── entrypoint ───────────────────────────────────────────────────────── */

let countsBefore = null;
try {
  ({ countsBefore } = await main());
} catch (error) {
  console.error(`\nFATAL: ${error instanceof Error ? error.stack : String(error)}`);
  results.fail++;
  failureDetails.push({ section: 'fatal', name: 'suite crashed', detail: String(error) });
} finally {
  await runCleanup();

  section('Residue check — table row counts unchanged after teardown');
  if (countsBefore) {
    const countsAfter = await tableCounts();
    for (const table of Object.keys(countsBefore)) {
      check(
        `${table}: row count unchanged (${countsBefore[table]})`,
        countsBefore[table] === countsAfter[table],
        `before=${countsBefore[table]} after=${countsAfter[table]}`,
      );
    }
  } else {
    skip('residue check', 'suite crashed before a baseline count was captured');
  }

  console.log('\n=== Summary ===');
  console.log(`  pass: ${results.pass}`);
  console.log(`  fail: ${results.fail}`);
  console.log(`  skip: ${results.skip}`);
  if (failureDetails.length > 0) {
    console.log('\nFailures:');
    for (const f of failureDetails) {
      console.log(`  [${f.section}] ${f.name}${f.detail ? ` -- ${f.detail}` : ''}`);
    }
  }

  await pool.end();
  process.exitCode = results.fail > 0 ? 1 : 0;
}
