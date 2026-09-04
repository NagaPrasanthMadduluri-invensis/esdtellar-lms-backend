/**
 * Deletes SCORM packages that nothing references.
 *
 * WHY THESE EXIST. The lesson editor uploads the zip BEFORE saving the lesson
 * (it needs the package id, and the manifest's declared duration, to build the
 * lesson payload). The package row and its extracted files are committed
 * either way — so every abandoned or failed lesson save leaves a package
 * behind that no lesson ever pointed at. Ten uploads on 2026-09-04 left eight
 * of them.
 *
 * `scorm_packages.claimed_at` and the sweep in `ScormService.upload` stop new
 * ones accumulating. This script is for the backlog, and for the crash cases
 * the sweep's conservative age threshold deliberately leaves alone.
 *
 * Two classes are cleaned:
 *   1. ROWS with no reference  — a package nothing points at (below).
 *   2. DIRECTORIES with no row — files left behind when a package was deleted
 *      but its directory removal failed, or when a row was removed directly in
 *      SQL. These are invisible to the application entirely, so nothing but a
 *      disk-vs-database comparison will ever find them.
 *
 *      GIT-TRACKED DIRECTORIES ARE NEVER TOUCHED. `storage/scorm/` holds a
 *      couple of hand-built sample packages that are committed to the
 *      repository and have no database row by design. By the "no row" rule
 *      alone they look exactly like debris, and this script deleted them once
 *      before this check existed. Being in git is the signal that a human put
 *      them there deliberately.
 *
 * ORPHAN (class 1) means referenced by NOTHING:
 *   - no lessons.scorm_package_id
 *   - no user_scorm_assignments (a library package assigned directly to
 *     learners is in use even with no lesson)
 *   - no scorm_tracking, scorm_attempts or scorm_datamodel_log
 *
 * That last group is the important guard: a package a learner has actually
 * worked through must never be deleted, even if the lesson that carried it was
 * removed — the attempt history is the record of their training.
 *
 *   node scripts/clean-orphan-scorm.mjs            (dry run — lists them)
 *   node scripts/clean-orphan-scorm.mjs --commit   (deletes rows + files)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const commit = process.argv.includes('--commit');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const configuredRoot = process.env.SCORM_STORAGE_PATH ?? './storage/scorm';
const storageRoot = isAbsolute(configuredRoot)
  ? configuredRoot
  : resolve(new URL('..', import.meta.url).pathname, configuredRoot);

try {
  const { rows: orphans } = await pool.query(`
    SELECT sp.id, sp.title, sp.version, sp.package_dir, sp.storage_prefix,
           sp.organization_id, sp.created_at
    FROM scorm_packages sp
    WHERE NOT EXISTS (SELECT 1 FROM lessons l WHERE l.scorm_package_id = sp.id)
      AND NOT EXISTS (SELECT 1 FROM user_scorm_assignments a WHERE a.package_id = sp.id)
      AND NOT EXISTS (SELECT 1 FROM scorm_tracking t WHERE t.package_id = sp.id)
      AND NOT EXISTS (SELECT 1 FROM scorm_attempts t WHERE t.package_id = sp.id)
      AND NOT EXISTS (SELECT 1 FROM scorm_datamodel_log d WHERE d.package_id = sp.id)
    ORDER BY sp.created_at
  `);

  /**
   * Class 2: directories on disk with no row. Compared against EVERY row, not
   * just the orphans above, so a directory belonging to a live package is
   * never touched. `.gitkeep` and any other dotfile is skipped — the storage
   * root is a tracked directory in the repository.
   */
  const { rows: allRows } = await pool.query(
    'SELECT package_dir FROM scorm_packages',
  );
  const knownDirs = new Set(allRows.map((r) => r.package_dir));

  /**
   * Directories git knows about, which are therefore intentional fixtures
   * rather than debris. `git ls-files` is asked once for the whole storage
   * root; if git is unavailable the answer is an empty set AND the file sweep
   * is skipped entirely, because without it there is no way to tell a
   * committed sample package from an orphan.
   */
  let tracked = new Set();
  let gitAvailable = false;
  try {
    const listed = execFileSync(
      'git',
      ['ls-files', '-z', '--', storageRoot],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const file of listed.split('\0').filter(Boolean)) {
      // Take the first path segment below the storage root.
      const rel = file.split('storage/scorm/')[1];
      if (rel) tracked.add(rel.split('/')[0]);
    }
    gitAvailable = true;
  } catch {
    console.warn(
      'git is unavailable, so committed sample packages cannot be told apart ' +
        'from orphaned directories — skipping the file sweep. Row cleanup ' +
        'still runs.',
    );
  }

  let staleDirs = [];
  if (gitAvailable) {
    try {
      staleDirs = readdirSync(storageRoot)
        .filter((name) => !name.startsWith('.'))
        .filter((name) => !knownDirs.has(name))
        .filter((name) => !tracked.has(name));
    } catch {
      console.warn(`Could not read ${storageRoot} — skipping the file sweep.`);
    }
  }

  if (orphans.length === 0 && staleDirs.length === 0) {
    console.log('No orphaned SCORM packages and no stale directories.');
    process.exit(0);
  }

  console.log(`${orphans.length} orphaned SCORM package(s):\n`);
  for (const p of orphans) {
    const dir = join(storageRoot, p.package_dir);
    const onDisk = existsSync(dir);
    console.log(
      `  id=${String(p.id).padStart(3)}  org=${p.organization_id}  ` +
        `v${p.version}  ${p.created_at.toISOString?.() ?? p.created_at}  ` +
        `${p.title}`,
    );
    console.log(
      `        files: ${
        p.storage_prefix
          ? `object storage, prefix ${p.storage_prefix} (NOT removed by this script)`
          : onDisk
            ? dir
            : `${dir} (already gone)`
      }`,
    );
  }

  if (staleDirs.length > 0) {
    console.log(`\n${staleDirs.length} directory/ies on disk with no package row:\n`);
    for (const name of staleDirs) {
      console.log(`  ${join(storageRoot, name)}`);
    }
  }

  if (!commit) {
    console.log('\nDry run. Re-run with --commit to delete these rows and their files.');
    process.exit(0);
  }

  // Rows first, then files: a deleted row with files still present costs disk,
  // whereas deleted files with the row still present would 404 a package the
  // library still lists. Same ordering as ScormService.deletePackage.
  const ids = orphans.map((p) => p.id);
  const { rowCount } = await pool.query(
    'DELETE FROM scorm_packages WHERE id = ANY($1)',
    [ids],
  );
  console.log(`\nDeleted ${rowCount} row(s).`);

  let removed = 0;
  let skipped = 0;
  for (const p of orphans) {
    if (p.storage_prefix) {
      // Object storage needs the app's credentials and the R2 client. Deleting
      // those prefixes belongs in the API, not in a script that only holds a
      // database URL — report them rather than pretend they are gone.
      skipped += 1;
      continue;
    }
    const dir = join(storageRoot, p.package_dir);
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      console.warn(`  could not remove ${dir}: ${error.message}`);
    }
  }
  console.log(`Removed ${removed} local directory/ies.`);

  let staleRemoved = 0;
  for (const name of staleDirs) {
    try {
      await rm(join(storageRoot, name), { recursive: true, force: true });
      staleRemoved += 1;
    } catch (error) {
      console.warn(`  could not remove ${name}: ${error.message}`);
    }
  }
  if (staleDirs.length > 0) {
    console.log(`Removed ${staleRemoved} stale directory/ies with no package row.`);
  }
  if (skipped > 0) {
    console.log(
      `${skipped} package(s) were in object storage — their keys were NOT deleted. ` +
        'Delete those prefixes from the bucket, or re-run once a driver-aware ' +
        'cleanup exists.',
    );
  }
} finally {
  await pool.end();
}
