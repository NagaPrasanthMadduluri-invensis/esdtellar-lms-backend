/**
 * Creates a PLATFORM administrator — the super-admin that operates above every
 * organization (specs/multi-tenancy.md §4.2).
 *
 * This script exists because nothing else could create one. `migrate-tenancy.mjs`
 * creates organizations but no users; `seed.mjs` creates the platform
 * ORGANIZATION and then only ever inserts `@edstellar.com` users into a real
 * org — so a fresh database ends up with a `__platform` org containing nobody,
 * and `POST /api/platform/organizations/:id/admins` cannot bootstrap the first
 * one because that route is itself `@PlatformAdmin()`-guarded. The account was
 * therefore created by hand, on one machine, which is why logging in as it
 * anywhere else returned 401.
 *
 *   node scripts/create-platform-admin.mjs                       (dry run)
 *   node scripts/create-platform-admin.mjs --commit              (applies it)
 *   node scripts/create-platform-admin.mjs --email a@b.com --first Ada --last L --commit
 *
 * The password is read from a hidden prompt, never from argv, so it does not
 * land in shell history or in the process list. For a non-interactive run set
 * PLATFORM_ADMIN_PASSWORD instead.
 *
 * Dry run is the default and it genuinely exercises the work: the INSERT runs,
 * the stored hash is read back and verified, and then the transaction ROLLBACKs.
 * The only side effect a rollback cannot undo is `users_id_seq` advancing past
 * the id it allocated and discarded — harmless, but worth knowing before
 * wondering why the committed row is not the id the dry run showed.
 */
import { createInterface } from 'node:readline';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';

/* ── .env, loaded the way the other scripts in this directory do ─────────── */
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

/* ── password helpers ─────────────────────────────────────────────────────────
   Format-locked, mirroring src/common/crypto/password.util.ts exactly:
   `scryptSync(password, salt, 64)` with a 16-byte hex salt, stored as
   `<derivedKeyHex>.<saltHex>`. A bcrypt or argon hash written here would be
   accepted by the column and then fail every login with the same generic 401,
   which is the single most confusing way to get this wrong. */
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  return `${scryptSync(password, salt, KEY_LENGTH).toString('hex')}.${salt}`;
}

function verifyPassword(password, stored) {
  try {
    const [hash, salt] = String(stored).split('.');
    if (!hash || !salt) return false;
    const storedBuf = Buffer.from(hash, 'hex');
    const suppliedBuf = scryptSync(password, salt, KEY_LENGTH);
    if (storedBuf.length !== suppliedBuf.length) return false;
    return timingSafeEqual(storedBuf, suppliedBuf);
  } catch {
    return false;
  }
}

/** Mirrors `isPasswordStrong` in password.util.ts. */
function isPasswordStrong(password) {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

/**
 * Passwords that are committed to this repository, in
 * `scripts/test-isolation.mjs` and `scripts/seed.mjs`. They are fine on a
 * development database — the isolation suite needs `Platform@123` to exist —
 * and unacceptable on anything reachable by other people, because a platform
 * admin can read every organization's data. Using one is possible, but only
 * deliberately.
 */
const PUBLIC_PASSWORDS = new Set(['Platform@123', 'Admin@123', 'Learner@123', 'Invensis@123']);

/* ── args ─────────────────────────────────────────────────────────────────── */
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const commit = flag('commit');
const allowPublicPassword = flag('allow-public-password');
const email = option('email', 'superadmin@edstellar.com').trim().toLowerCase();
const firstName = option('first', 'Platform');
const lastName = option('last', 'Admin');

/* ── hidden password prompt ───────────────────────────────────────────────── */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          'No terminal available for a hidden prompt. Set PLATFORM_ADMIN_PASSWORD instead:\n' +
            '  PLATFORM_ADMIN_PASSWORD=... node scripts/create-platform-admin.mjs --commit',
        ),
      );
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo the question once, then swallow every keystroke so the password
    // never appears on screen (and so it cannot be scrolled back to).
    rl._writeToOutput = (str) => {
      if (str.includes(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassword() {
  const fromEnv = process.env.PLATFORM_ADMIN_PASSWORD;
  if (fromEnv) {
    console.log('Password taken from PLATFORM_ADMIN_PASSWORD.');
    return fromEnv;
  }
  const first = await promptHidden(`Password for ${email}: `);
  const again = await promptHidden('Confirm password: ');
  if (first !== again) throw new Error('The two passwords did not match.');
  return first;
}

/* ── main ─────────────────────────────────────────────────────────────────── */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // The whole reason this script exists is that the account was missing from a
  // DIFFERENT database than the one it was created in, so honouring
  // DATABASE_SSL matters: this will often be pointed at a managed Postgres.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let exitCode = 0;

try {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to server/.env or inject it.');
  }

  /* Which database is about to be written to. Printed before anything else,
     because "the row exists on my laptop but the API returns 401" is the exact
     confusion this script is here to end. */
  const target = new URL(process.env.DATABASE_URL);
  console.log('\nTarget database');
  console.log(`  host:     ${target.hostname}:${target.port || 5432}`);
  console.log(`  database: ${target.pathname.slice(1)}`);
  console.log(`  user:     ${target.username}`);
  console.log(`  ssl:      ${process.env.DATABASE_SSL === 'true' ? 'on' : 'off'}`);

  /* ── the platform organization, resolved — never a hard-coded id ───────── */
  const { rows: platformRows } = await pool.query(
    'SELECT id, name, slug FROM organizations WHERE is_platform = true',
  );
  if (platformRows.length === 0) {
    throw new Error(
      'This database has no organization with is_platform = true, so there is ' +
        'no platform organization to put an admin in. Run the tenancy ' +
        'migration first:\n  node scripts/migrate-tenancy.mjs --commit',
    );
  }
  const platformOrg = platformRows[0];
  console.log(
    `\nPlatform organization: [${platformOrg.id}] ${platformOrg.name} (${platformOrg.slug})`,
  );

  /* ── who already administers it ───────────────────────────────────────── */
  const { rows: existing } = await pool.query(
    `SELECT id, email, is_active FROM users
      WHERE organization_id = $1 AND role = 'admin' ORDER BY id`,
    [platformOrg.id],
  );
  if (existing.length === 0) {
    console.log('Existing platform admins: none — this will be the first.');
  } else {
    console.log(`Existing platform admins (${existing.length}):`);
    for (const a of existing) {
      console.log(`  [${a.id}] ${a.email}${a.is_active === 1 ? '' : '  (INACTIVE)'}`);
    }
  }

  /* ── the email must be free: users.email is globally UNIQUE (spec §3.1) ── */
  const { rows: clash } = await pool.query(
    `SELECT u.id, u.role, u.organization_id, o.name AS org_name, o.is_platform
       FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE lower(u.email) = $1`,
    [email],
  );
  if (clash.length > 0) {
    const u = clash[0];
    const where = u.is_platform ? 'the platform organization' : `"${u.org_name}"`;
    throw new Error(
      `${email} already exists — id ${u.id}, role "${u.role}", in ${where}.\n` +
        'One email belongs to exactly one organization, so this script will not ' +
        'touch it. Pick another address with --email, or change that account ' +
        "instead if it is the one you meant.",
    );
  }

  /* ── password ─────────────────────────────────────────────────────────── */
  const password = await readPassword();

  if (!password) throw new Error('No password given.');
  if (!isPasswordStrong(password)) {
    throw new Error(
      'Password is too weak. It needs at least 8 characters, one uppercase ' +
        'letter, one digit and one symbol — the same rule the change-password ' +
        'form enforces.',
    );
  }
  if (PUBLIC_PASSWORDS.has(password) && !allowPublicPassword) {
    throw new Error(
      'That password is committed to this repository (scripts/test-isolation.mjs, ' +
        'scripts/seed.mjs). A platform admin can read every organization\'s data, ' +
        'so it must not guard one on any system other people can reach.\n' +
        'On a development database this is fine and intended — the isolation ' +
        'suite needs it. Re-run with --allow-public-password to say so.',
    );
  }
  if (PUBLIC_PASSWORDS.has(password)) {
    console.log(
      '\n  WARNING: this password is public — it is committed in this repository.\n' +
        '           Acceptable on a development database only.',
    );
  }

  /* ── insert, verify, then commit or roll back ─────────────────────────── */
  console.log(`\n${commit ? 'Creating' : 'DRY RUN — would create'} platform admin:`);
  console.log(`  email: ${email}`);
  console.log(`  name:  ${firstName} ${lastName}`);
  console.log(`  role:  admin`);
  console.log(`  org:   ${platformOrg.id} (${platformOrg.slug})`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inserted } = await client.query(
      `INSERT INTO users (first_name, last_name, email, password, role, organization_id)
       VALUES ($1, $2, $3, $4, 'admin', $5)
       RETURNING id, email, role, is_active, organization_id`,
      [firstName, lastName, email, hashPassword(password), platformOrg.id],
    );
    const row = inserted[0];

    /* Read the hash back and verify the supplied password against it, inside
       the transaction. This is what catches a wrong hash FORMAT here rather
       than as an indistinguishable 401 at the login form later. */
    const { rows: readBack } = await client.query('SELECT password FROM users WHERE id = $1', [
      row.id,
    ]);
    if (!verifyPassword(password, readBack[0].password)) {
      throw new Error(
        'Stored hash does not verify against the password just used. Refusing ' +
          'to commit — the hash format in this script no longer matches ' +
          'src/common/crypto/password.util.ts.',
      );
    }

    /* The API decides "is platform admin" by comparing role and organization_id
       against the platform org it resolved at boot, so assert the same thing
       here rather than trusting the INSERT. */
    const isPlatformAdmin = row.role === 'admin' && row.organization_id === platformOrg.id;
    if (!isPlatformAdmin) {
      throw new Error(
        `Row would not be a platform admin (role=${row.role}, organization_id=${row.organization_id}).`,
      );
    }

    console.log('\nChecks');
    console.log(`  stored hash verifies:        yes`);
    console.log(`  resolves as platform admin:  yes`);
    console.log(`  is_active:                   ${row.is_active}`);

    if (commit) {
      await client.query('COMMIT');
      console.log(`\nCommitted. User id ${row.id}.`);
      console.log('\nNext:');
      console.log(`  1. Sign in at the client with ${email}`);
      console.log('  2. The platform portal is at /platform/dashboard');
      console.log(
        '  3. The API resolves the platform org once at boot, so no restart is\n' +
          '     needed for this — the org already existed.',
      );
    } else {
      await client.query('ROLLBACK');
      console.log('\nRolled back — nothing was written (this was a dry run).');
      console.log('Re-run with --commit to apply it.');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await pool.end();
  process.exitCode = exitCode;
}
