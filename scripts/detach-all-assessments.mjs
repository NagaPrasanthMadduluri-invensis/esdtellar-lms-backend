/**
 * ONE-TIME: detach every existing assessment.
 *
 * Deliberately NOT a file in database/migrations/. Those run on every boot, and
 * a blanket `UPDATE assessments SET is_active = 0` there would re-hide every
 * assessment each time the API restarted — including ones an admin had just
 * attached. This is the "human checkpoint" case in BACKEND_STRUCTURE.md §6.2:
 * write the SQL, read it, run it deliberately, once.
 *
 * WHAT IT DOES, and why it is not reversible by re-running:
 *   - every assessment becomes invisible to learners immediately
 *   - in-progress learners lose access until an admin re-attaches
 *   - course completion and certificate eligibility recalculate, because both
 *     key off attached assessments — a course whose only assessment is now
 *     detached can become complete without it
 *
 * Run with:  node scripts/detach-all-assessments.mjs           (dry run)
 *            node scripts/detach-all-assessments.mjs --commit  (applies it)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

function env() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* env may be injected rather than filed */ }
}
env();

const commit = process.argv.includes('--commit');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, c.name AS course
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
      WHERE a.is_active = 1
      ORDER BY c.name, a.title`,
  );

  if (rows.length === 0) {
    console.log('Nothing attached — no change needed.');
  } else {
    console.log(`${rows.length} attached assessment(s) would be detached:\n`);
    for (const r of rows) console.log(`  [${r.id}] ${r.course} — ${r.title}`);

    if (!commit) {
      console.log('\nDRY RUN. Re-run with --commit to apply.');
    } else {
      const res = await pool.query('UPDATE assessments SET is_active = 0 WHERE is_active = 1');
      console.log(`\nDetached ${res.rowCount} assessment(s).`);
      console.log('Attach the ones you want live from /admin/courses/<id> → Assessments.');
    }
  }
} finally {
  await pool.end();
}
