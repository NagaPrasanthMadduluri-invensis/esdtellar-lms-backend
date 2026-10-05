/**
 * Move every local-disk SCORM package into R2, then record where it went.
 *
 *   node scripts/migrate-scorm-to-r2.mjs              (dry run — default)
 *   node scripts/migrate-scorm-to-r2.mjs --commit     (actually do it)
 *
 * Dry-run by default, matching `db:reset-to-admin`, `db:seed-history` and
 * `db:clean-orphan-scorm`. It is the one-off BACKEND_STRUCTURE §10.3 asks for:
 *
 *   > "no backfill exists for packages already on local disk, so flipping an
 *   > existing deployment to `s3` strands them (`storage_prefix IS NULL`
 *   > serves 404 under the `s3` handler). Write a one-off script that
 *   > re-uploads those directories and sets the prefix before flipping the
 *   > switch in production."
 *
 * ## It copies; it never deletes
 *
 * Nothing on disk is touched. After a successful run both copies exist, and
 * `SCORM_STORAGE_DRIVER=local` still serves the old one — so the migration
 * is fully reversible right up until somebody removes the files by hand.
 * Deleting here would make the rollback a restore-from-backup, and this
 * database has no backup.
 *
 * ## The database write is LAST, and per package
 *
 * `storage_prefix` is what makes the s3 handler look in R2. Setting it before
 * the bytes are up would 404 the package for however long the upload takes;
 * setting it per package rather than in one batch at the end means a failure
 * half way leaves the finished ones working and the rest still on disk,
 * rather than an all-or-nothing cliff.
 *
 * ## A package with no DB row is NOT migrated
 *
 * Debris from an abandoned lesson save (§10.9's provisional packages). It has
 * no `storage_prefix` to set and nothing references it, so copying it to R2
 * would just move the litter. `db:clean-orphan-scorm` is what removes it.
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import pg from 'pg';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/* ── .env, the same way the other scripts read it ───────────────────────── */
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

const COMMIT = process.argv.includes('--commit');
const ROOT = process.env.SCORM_STORAGE_PATH ?? './storage/scorm';

/**
 * Content types, because R2 serves what we tell it.
 *
 * A SCORM package is a little website — an `index.html` handed back as
 * `application/octet-stream` downloads instead of rendering, and a `.js`
 * served wrong is refused by the browser outright. The local driver never
 * had to care: `useStaticAssets` sniffed the extension for us.
 */
const TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.swf': 'application/x-shockwave-flash',
};
const typeOf = (name) => {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
};

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    // Keys use forward slashes on every platform; `relative` uses the
    // platform separator and this script may run on either.
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const missing = ['DATABASE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}. Set them in server/.env.`);
  process.exit(1);
}

const endpoint = process.env.R2_ENDPOINT
  || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const s3 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
});
await db.connect();

console.log(`\n${COMMIT ? '\x1b[31mCOMMIT\x1b[0m' : '\x1b[33mDRY RUN\x1b[0m'}  bucket=${process.env.R2_BUCKET}  root=${ROOT}\n`);

const { rows } = await db.query(
  `SELECT id, organization_id, package_dir, title, storage_prefix
     FROM scorm_packages ORDER BY id`,
);

let migrated = 0, skipped = 0, failed = 0, bytes = 0;

for (const pkg of rows) {
  const label = `#${pkg.id} ${String(pkg.title ?? '').slice(0, 40)}`;

  if (pkg.storage_prefix) {
    console.log(`  –  ${label} — already in R2 (${pkg.storage_prefix})`);
    skipped += 1;
    continue;
  }

  const dir = join(ROOT, pkg.package_dir);
  let files;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    files = walk(dir);
  } catch {
    // The row says local disk and the disk disagrees. Do NOT set a prefix:
    // that would point the s3 handler at an empty prefix and turn a visible
    // 404 into a package that silently loads nothing.
    console.log(`  !  ${label} — row says local disk but ${dir} is missing. Left alone.`);
    failed += 1;
    continue;
  }

  const prefix = `tenants/${pkg.organization_id}/scorm/${pkg.package_dir}/`;
  const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  console.log(`  →  ${label}`);
  console.log(`     ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${prefix}`);

  if (!COMMIT) { migrated += 1; bytes += total; continue; }

  try {
    for (const rel of files) {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `${prefix}${rel}`,
        Body: createReadStream(join(dir, rel)),
        ContentType: typeOf(rel),
        ContentLength: statSync(join(dir, rel)).size,
      }));
    }
    // Only now, with every byte up, does the package start being read from R2.
    await db.query('UPDATE scorm_packages SET storage_prefix = $1 WHERE id = $2',
      [prefix, pkg.id]);
    console.log(`     \x1b[32muploaded and recorded\x1b[0m`);
    migrated += 1;
    bytes += total;
  } catch (error) {
    // No prefix was written, so this package still serves from disk.
    console.log(`     \x1b[31mFAILED: ${error.message}\x1b[0m — still on local disk, unchanged`);
    failed += 1;
  }
}

await db.end();

console.log(`\n${migrated} migrated · ${skipped} already in R2 · ${failed} failed`
  + ` · ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);

if (!COMMIT) {
  console.log('Dry run. Re-run with --commit to upload.\n');
} else if (failed === 0) {
  console.log('Next: set SCORM_STORAGE_DRIVER=s3 and restart the API, then PLAY a');
  console.log('lesson before deleting anything. Local files are still intact, so');
  console.log('setting the driver back to `local` is the rollback.\n');
}
process.exit(failed > 0 ? 1 : 0);
