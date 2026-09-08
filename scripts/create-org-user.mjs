/**
 * Onboards one user into one organization, holding one of that organization's
 * roles. Spec: `specs/rbac.md` §3.4.
 *
 * This exists because no other path can do it. The admin UI's "Add User" flow
 * hardcodes `role: 'learner'` (`users.repository.ts` — `createLearner`), and
 * `POST /api/platform/organizations/:id/admins` only ever makes an org admin.
 * So a trainer — or a manager, or anything else an organization has defined —
 * has no way in without this. A role selector in the Add User dialog is the
 * proper fix and is part of the UI slice; until then, this is the mechanism.
 *
 *   node scripts/create-org-user.mjs --org edstellar --role trainer \
 *     --email trainer@edstellar.com --first Anita --last Rao
 *
 *   ... --commit                                  (applies it)
 *   PASSWORD=... node scripts/create-org-user.mjs ...   (non-interactive)
 *
 * `users.role` is written from the role's `portal`, never passed in: the portal
 * selector is derived so the two cannot disagree (§3.4). The password is read
 * from a hidden prompt so it stays out of shell history.
 */
import { createInterface } from 'node:readline';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

/* Format-locked, mirroring src/common/crypto/password.util.ts. A hash in any
   other format is accepted by the column and then fails every login with the
   same generic 401. */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
}
function verifyPassword(password, stored) {
  try {
    const [hash, salt] = String(stored).split('.');
    const a = Buffer.from(hash, 'hex');
    const b = scryptSync(password, salt, 64);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
function isPasswordStrong(p) {
  return p.length >= 8 && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
}

function flag(n) {
  return process.argv.includes(`--${n}`);
}
function option(n, fallback) {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const commit = flag('commit');
const orgRef = option('org', '');
const roleKey = option('role', '');
const email = option('email', '').trim().toLowerCase();
const firstName = option('first', '');
const lastName = option('last', '');
const department = option('department', null);

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No terminal for a hidden prompt. Set PASSWORD=... instead.'));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let exitCode = 0;

try {
  for (const [name, value] of [
    ['org', orgRef],
    ['role', roleKey],
    ['email', email],
    ['first', firstName],
    ['last', lastName],
  ]) {
    if (!value) throw new Error(`--${name} is required.`);
  }

  const target = new URL(process.env.DATABASE_URL);
  console.log(`\nTarget: ${target.hostname}:${target.port || 5432}/${target.pathname.slice(1)}`);
  console.log(commit ? 'Mode:   COMMIT' : 'Mode:   dry run (rolls back at the end)');

  const client = await pool.connect();
  try {
    const { rows: orgs } = await client.query(
      'SELECT id, name, slug FROM organizations WHERE slug = $1 OR id::text = $1',
      [orgRef],
    );
    if (orgs.length === 0) throw new Error(`No organization matches "${orgRef}".`);
    const org = orgs[0];

    const { rows: roles } = await client.query(
      'SELECT id, key, label, portal, scope FROM roles WHERE organization_id = $1 AND key = $2',
      [org.id, roleKey],
    );
    if (roles.length === 0) {
      const { rows: available } = await client.query(
        'SELECT key FROM roles WHERE organization_id = $1 ORDER BY key',
        [org.id],
      );
      throw new Error(
        `"${roleKey}" is not a role in ${org.slug}. Available: ` +
          `${available.map((r) => r.key).join(', ') || '(none — run db:migrate:rbac)'}.\n` +
          'Create it with: node scripts/create-org-role.mjs --org ' + org.slug + ' --key ... --commit',
      );
    }
    const role = roles[0];

    const { rows: clash } = await client.query(
      `SELECT u.id, u.role, o.slug FROM users u JOIN organizations o ON o.id = u.organization_id
        WHERE lower(u.email) = $1`,
      [email],
    );
    if (clash.length > 0) {
      throw new Error(
        `${email} already exists — id ${clash[0].id}, role "${clash[0].role}", in ` +
          `"${clash[0].slug}". One email belongs to exactly one organization.`,
      );
    }

    const password = process.env.PASSWORD || (await promptHidden(`Password for ${email}: `));
    if (!password) throw new Error('No password given.');
    if (!isPasswordStrong(password)) {
      throw new Error(
        'Password needs 8+ characters with an uppercase letter, a digit and a symbol.',
      );
    }

    console.log(`\n${commit ? 'Creating' : 'Would create'}:`);
    console.log(`  email:      ${email}`);
    console.log(`  name:       ${firstName} ${lastName}`);
    console.log(`  org:        [${org.id}] ${org.name}`);
    console.log(`  role:       ${role.label} (${role.key}) — role_id ${role.id}`);
    console.log(`  portal:     ${role.portal}   <- users.role is written from this`);
    console.log(`  scope:      ${role.scope}`);
    console.log(`  department: ${department ?? '(none)'}`);

    await client.query('BEGIN');
    const { rows: created } = await client.query(
      `INSERT INTO users (first_name, last_name, email, password, role, role_id, organization_id, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, role, role_id, organization_id`,
      [
        firstName,
        lastName,
        email,
        hashPassword(password),
        // Derived from the role, never supplied — see §3.4.
        role.portal,
        role.id,
        org.id,
        department,
      ],
    );
    const row = created[0];

    const { rows: readBack } = await client.query('SELECT password FROM users WHERE id = $1', [
      row.id,
    ]);
    if (!verifyPassword(password, readBack[0].password)) {
      throw new Error('Stored hash does not verify — refusing to commit.');
    }

    console.log('\nChecks');
    console.log('  stored hash verifies:  yes');
    console.log(`  users.role:            ${row.role} (matches the role's portal)`);
    console.log(`  role_id:               ${row.role_id}`);

    if (commit) {
      await client.query('COMMIT');
      console.log(`\nCOMMITTED. User id ${row.id}.`);
      if (role.portal === 'trainer') {
        console.log(
          '\nHe will land on /trainer/sessions and see nothing until a session is\n' +
            'assigned to him: sessions.trainer_user_id must be set to ' +
            `${row.id}.`,
        );
      }
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --commit to apply.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
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
