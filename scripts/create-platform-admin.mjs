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
/**
 * Resets an EXISTING platform admin's password instead of creating one.
 *
 * Added because the failure it addresses actually happened: the account was
 * present in production all along and the password simply was not the one
 * being tried, so `superadmin` answered 401 and looked missing. Creating is
 * refused (one email, one organization) and there was no other way in short
 * of hand-writing a scrypt hash — which is format-locked
 * (`BACKEND_STRUCTURE.md` §6.4) and exactly the thing not to do by hand.
 *
 * Deliberately opt-in: without the flag an existing email still fails loudly,
 * so nobody overwrites a live credential by re-running the create command.
 */
const resetPassword = flag('reset-password');
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
  /**
   * `existingAdmin` is set only when the clash IS the account we would have
   * created: same email, admin, inside the platform organization. That is the
   * one case a password reset is safe, and the flag still has to ask for it.
   */
  let existingAdmin = null;
  if (clash.length > 0) {
    const u = clash[0];
    const where = u.is_platform ? 'the platform organization' : `"${u.org_name}"`;
    const isPlatformAdminRow =
      u.is_platform && u.role === 'admin' && u.organization_id === platformOrg.id;

    if (resetPassword && isPlatformAdminRow) {
      existingAdmin = u;
      console.log(
        `\nRESETTING the password for an existing platform admin: [${u.id}] ${email}`,
      );
    } else {
      throw new Error(
        `${email} already exists — id ${u.id}, role "${u.role}", in ${where}, ` +
          `on ${target.hostname}${target.pathname}.\n` +
          'One email belongs to exactly one organization, so this script will ' +
          'not create it again.\n' +
          (isPlatformAdminRow
            ? '  It IS a platform admin, so if the problem is a forgotten ' +
              'password, re-run with --reset-password --commit.\n'
            : '  Pick another address with --email.\n') +
          `  If you meant a different database, check the target above — this ` +
          `run went to ${target.hostname}${target.pathname}.`,
      );
    }
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
  const verb = existingAdmin
    ? commit ? 'Resetting the password for' : 'DRY RUN — would reset the password for'
    : commit ? 'Creating' : 'DRY RUN — would create';
  console.log(`\n${verb} platform admin:`);
  console.log(`  email: ${email}`);
  console.log(`  name:  ${firstName} ${lastName}`);
  console.log(`  role:  admin`);
  console.log(`  org:   ${platformOrg.id} (${platformOrg.slug})`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /**
     * `users.role_id` is NOT NULL once `migrate-rbac.mjs` has run
     * (`specs/rbac.md` §3.4), so the insert below has to name a role or it
     * fails outright. This script predates RBAC and did not — which meant the
     * one command that can bootstrap a super-admin stopped working on exactly
     * the databases that had been migrated, and the failure looked like a
     * mysterious 500 at the moment someone was trying to get in for the first
     * time.
     *
     * Resolved by key against the PLATFORM organization, which is what the
     * composite FK `users_role_same_org` requires. Null is passed through on a
     * pre-RBAC database, where the column is still nullable and null is right
     * — so this works on both, rather than only on whichever was set up last.
     */
    if (existingAdmin) {
      /**
       * Password only. Role, organization and role_id are left exactly as they
       * are — this account already works, the credential is the only thing
       * being replaced, and touching anything else would turn a password reset
       * into an unreviewed permission change.
       *
       * `perm_version` IS bumped: a password reset must invalidate whatever
       * sessions are already out there, and that counter is the mechanism
       * AuthGuard checks (`specs/rbac.md` §3.6). Without it a stolen cookie
       * would outlive the password it was obtained with.
       */
      const { rows: updated } = await client.query(
        `UPDATE users
            SET password = $1, perm_version = perm_version + 1, is_active = 1
          WHERE id = $2
          RETURNING id, email, role, is_active, organization_id, role_id, perm_version`,
        [hashPassword(password), existingAdmin.id],
      );
      const row = updated[0];

      const { rows: readBack } = await client.query(
        'SELECT password FROM users WHERE id = $1',
        [row.id],
      );
      if (!verifyPassword(password, readBack[0].password)) {
        throw new Error(
          'Stored hash does not verify against the password just used. ' +
            'Refusing to commit.',
        );
      }
      const stillPlatformAdmin =
        row.role === 'admin' && row.organization_id === platformOrg.id;

      console.log('\nChecks');
      console.log(`  stored hash verifies:        ${'yes'}`);
      console.log(`  resolves as platform admin:  ${stillPlatformAdmin ? 'yes' : 'NO'}`);
      console.log(`  is_active:                   ${row.is_active}`);
      console.log(`  role_id (unchanged):         ${row.role_id}`);
      console.log(`  perm_version:                ${row.perm_version}  (existing sessions invalidated)`);
      if (!stillPlatformAdmin) throw new Error('Row would not be a platform admin.');

      if (commit) {
        await client.query('COMMIT');
        console.log(`\nCommitted. ${email} can sign in with the new password.`);
      } else {
        await client.query('ROLLBACK');
        console.log('\nRolled back — nothing was written (this was a dry run).');
        console.log('Re-run with --reset-password --commit to apply it.');
      }
      client.release();
      await pool.end();
      process.exit(0);
    }

    let adminRoleId = null;
    try {
      const { rows: roleRows } = await client.query(
        `SELECT id FROM roles WHERE organization_id = $1 AND key = 'admin'`,
        [platformOrg.id],
      );
      adminRoleId = roleRows[0]?.id ?? null;
      if (adminRoleId === null) {
        const { rows: notNull } = await client.query(
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'role_id'`,
        );
        if (notNull[0]?.is_nullable === 'NO') {
          throw new Error(
            `The platform organization (${platformOrg.slug}) has no "admin" role, ` +
              'and users.role_id is NOT NULL, so this account cannot be created.\n' +
              '  Run:  npm run db:migrate:rbac -- --commit\n' +
              '  then re-run this script.',
          );
        }
      }
    } catch (error) {
      // A missing `roles` table means RBAC has not been applied at all, which
      // is fine — role_id is still nullable there. Anything else is real.
      if (!/relation "roles" does not exist/.test(error.message)) throw error;
    }
    console.log(`  role_id: ${adminRoleId ?? '(null — pre-RBAC database)'}`);

    const { rows: inserted } = await client.query(
      `INSERT INTO users (first_name, last_name, email, password, role, organization_id, role_id)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6)
       RETURNING id, email, role, is_active, organization_id, role_id`,
      [firstName, lastName, email, hashPassword(password), platformOrg.id, adminRoleId],
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
