/**
 * Issues the certificates that completion should already have produced.
 *
 * WHY THIS EXISTS. `CertificatesService.autoIssue` fires ONCE, at the moment a
 * lesson is marked complete, with no scheduler and no retry (BACKEND_STRUCTURE
 * §10.23). So anything that completed before auto-issue could see it — a
 * platform course before the §10.23 scope fix, a course finished while storage
 * was misbehaving, a learning path completed before §10.11 wired its issuance,
 * or history written straight into the tables — is a completion with no
 * certificate and nothing to go back and mint one. This is that one-off sweep.
 *
 * WHAT "COMPLETE" MEANS is the SAME definition the product uses everywhere
 * (`CertificatesService.evaluate` over `getCompletionSnapshot`, §10.11):
 *   - every active lesson in every active module of the course is complete,
 *   - and, if the course carries an active assessment, it has been passed.
 * A journey is complete when `journey_enrollments.completed_at` is set — the
 * caller (`JourneysService.onCourseProgress`) already decided that against the
 * one definition, so this does not re-derive it (mirrors `issueForJourney`).
 *
 * WHAT IT WILL NOT DO, by construction, because these never auto-issue:
 *   - a SESSION's companion training (§10.7) — attendance is the admin's call,
 *   - an approved EXTERNAL certification (§10.26) — the awarding body issued it,
 *   - a (user, course|journey) that already has ANY certificate row, revoked or
 *     not — so it never overturns an admin's revocation.
 * The learner's org owns the certificate row; completion activity is matched on
 * that same org, so a shared platform course finished in another tenant does
 * not leak a certificate here.
 *
 * It does NOT notify or email anyone: these are historical completions, and a
 * fan-out of "your certificate is ready" for a course somebody finished months
 * ago is noise. The row simply appears on their Certificates page.
 *
 *   node scripts/backfill-certificates.mjs                 (dry run — prints the plan)
 *   node scripts/backfill-certificates.mjs --commit        (applies it)
 *   node scripts/backfill-certificates.mjs --org=10        (one organization only)
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
const ORG = orgArg ? Number(orgArg.split('=')[1]) : null;

if (ORG !== null && (!Number.isInteger(ORG) || ORG <= 0)) {
  console.error('--org must be a positive integer');
  process.exit(1);
}

// ── Mirrors src/common/certificate-branding.ts. Duplicated because that is a
// TS module behind a path alias and this is a .mjs script; the code format is
// `<PREFIX>-<12 hex>` for a course and `<PREFIX>-J-<12 hex>` for a journey. ──
const DEFAULT_PREFIX = 'EDS';
const PREFIX_PATTERN = /^[A-Z0-9]{2,10}$/;
const CODE_HASH_CHARS = 12;

function certificatePrefix(stored) {
  const value = stored == null ? null : String(stored).trim().toUpperCase() || null;
  return value && PREFIX_PATTERN.test(value) ? value : DEFAULT_PREFIX;
}
function codeHash(seed) {
  return createHash('sha256')
    .update(`${seed}:${Date.now()}:${randomBytes(16).toString('hex')}`)
    .digest('hex')
    .slice(0, CODE_HASH_CHARS)
    .toUpperCase();
}
function courseCode(prefix, courseId, userId) {
  return `${certificatePrefix(prefix)}-${codeHash(`${courseId}:${userId}`)}`;
}
function journeyCode(prefix, journeyId, userId) {
  return `${certificatePrefix(prefix)}-J-${codeHash(`J${journeyId}:${userId}`)}`;
}

const orgFilter = ORG === null ? '' : 'AND u.organization_id = $1';
const orgParams = ORG === null ? [] : [ORG];

/**
 * Candidate COURSE certificates — a complete (user, course) with no cert.
 *
 * The completion arithmetic is inlined to match `getCompletionSnapshot`: total
 * active lessons, the learner's completed ones (scoped to their own org), and
 * the assessment gate. A course that is a session training or an external
 * certification is excluded; so is any pair that already holds a certificate.
 */
const COURSE_SQL = `
  WITH pairs AS (
    SELECT DISTINCT ulc.user_id, cm.course_id
    FROM user_lesson_completions ulc
    JOIN lessons l        ON l.id = ulc.lesson_id
    JOIN course_modules cm ON cm.id = l.module_id
  )
  SELECT
    u.organization_id,
    p.user_id,
    p.course_id,
    c.name AS course_name,
    o.certificate_prefix,
    (SELECT COUNT(*) FROM lessons l2
       JOIN course_modules cm2 ON cm2.id = l2.module_id
      WHERE cm2.course_id = p.course_id AND l2.is_active = 1 AND cm2.is_active = 1) AS total_lessons,
    (SELECT COUNT(*) FROM user_lesson_completions ulc2
       JOIN lessons l3 ON l3.id = ulc2.lesson_id
       JOIN course_modules cm3 ON cm3.id = l3.module_id
      WHERE cm3.course_id = p.course_id AND l3.is_active = 1 AND cm3.is_active = 1
        AND ulc2.user_id = p.user_id AND ulc2.organization_id = u.organization_id) AS done_lessons,
    EXISTS (SELECT 1 FROM assessments a WHERE a.course_id = p.course_id AND a.is_active = 1) AS has_assessment,
    EXISTS (SELECT 1 FROM user_assessment_attempts uaa
              JOIN assessments a2 ON a2.id = uaa.assessment_id
             WHERE a2.course_id = p.course_id AND a2.is_active = 1
               AND uaa.user_id = p.user_id AND uaa.is_passed = 1
               AND uaa.organization_id = u.organization_id) AS has_passed
  FROM pairs p
  JOIN users u   ON u.id = p.user_id
  JOIN courses c ON c.id = p.course_id
  JOIN organizations o ON o.id = u.organization_id
  WHERE c.session_id IS NULL
    AND c.external_certification_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM certificates ce WHERE ce.user_id = p.user_id AND ce.course_id = p.course_id)
    ${orgFilter}
`;

/** Candidate JOURNEY certificates — a completed enrollment with no path cert. */
const JOURNEY_SQL = `
  SELECT je.user_id, je.journey_id, u.organization_id, j.title AS journey_name, o.certificate_prefix
  FROM journey_enrollments je
  JOIN users u   ON u.id = je.user_id
  JOIN journeys j ON j.id = je.journey_id
  JOIN organizations o ON o.id = u.organization_id
  WHERE je.completed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM certificates ce WHERE ce.user_id = je.user_id AND ce.journey_id = je.journey_id)
    ${orgFilter}
`;

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const courseRows = (await pool.query(COURSE_SQL, orgParams)).rows
    .filter((r) => Number(r.total_lessons) > 0
      && Number(r.done_lessons) >= Number(r.total_lessons)
      && (!r.has_assessment || r.has_passed));

  const journeyRows = (await pool.query(JOURNEY_SQL, orgParams)).rows;

  // Whether a path certificate can even be written: course_id must be nullable
  // (migrate-journey-certificates.mjs). If it is still NOT NULL and there are
  // candidates, say so rather than failing on the INSERT.
  const nullableRow = (await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'certificates' AND column_name = 'course_id'`,
  )).rows[0];
  const courseIdNullable = nullableRow?.is_nullable === 'YES';

  console.log(`\nCertificate backfill — ${commit ? 'COMMIT' : 'DRY RUN'}${ORG ? ` (org ${ORG})` : ' (all orgs)'}\n`);
  console.log(`  Course completions missing a certificate : ${courseRows.length}`);
  console.log(`  Path completions missing a certificate   : ${journeyRows.length}`);
  if (journeyRows.length > 0 && !courseIdNullable) {
    console.log('\n  ⚠ certificates.course_id is still NOT NULL — run');
    console.log('    scripts/migrate-journey-certificates.mjs --commit  before path certs can be issued.');
  }

  const sample = (rows, fmt) => rows.slice(0, 8).map((r) => `      ${fmt(r)}`).join('\n');
  if (courseRows.length) {
    console.log('\n  Course certificates to issue (first 8):');
    console.log(sample(courseRows, (r) => `org ${r.organization_id}  user ${r.user_id}  "${r.course_name}"`));
  }
  if (journeyRows.length) {
    console.log('\n  Path certificates to issue (first 8):');
    console.log(sample(journeyRows, (r) => `org ${r.organization_id}  user ${r.user_id}  "${r.journey_name}"`));
  }

  if (!commit) {
    console.log('\n  Dry run — nothing written. Re-run with --commit to apply.\n');
    await pool.end();
    return;
  }

  const now = new Date().toISOString();
  let issuedCourses = 0;
  let issuedJourneys = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of courseRows) {
      const score = r.has_assessment
        ? (await client.query(
            `SELECT MAX(uaa.percentage) AS best FROM user_assessment_attempts uaa
               JOIN assessments a ON a.id = uaa.assessment_id
              WHERE a.course_id = $1 AND a.is_active = 1 AND uaa.user_id = $2 AND uaa.organization_id = $3`,
            [r.course_id, r.user_id, r.organization_id],
          )).rows[0].best
        : null;
      await client.query(
        `INSERT INTO certificates
           (organization_id, user_id, course_id, certificate_code, issued_at, final_score, is_revoked)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [r.organization_id, r.user_id, r.course_id,
         courseCode(r.certificate_prefix, r.course_id, r.user_id), now,
         score == null ? null : Math.round(Number(score))],
      );
      issuedCourses += 1;
    }
    if (courseIdNullable) {
      for (const r of journeyRows) {
        await client.query(
          `INSERT INTO certificates
             (organization_id, user_id, course_id, journey_id, certificate_code, issued_at, final_score, is_revoked)
           VALUES ($1, $2, NULL, $3, $4, $5, NULL, 0)`,
          [r.organization_id, r.user_id, r.journey_id,
           journeyCode(r.certificate_prefix, r.journey_id, r.user_id), now],
        );
        issuedJourneys += 1;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n  Issued ${issuedCourses} course certificate(s) and ${issuedJourneys} path certificate(s).\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
