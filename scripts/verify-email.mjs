/**
 * Read-only health check for the email system.
 *
 *   node scripts/verify-email.mjs        (or: npm run email:verify)
 *
 * The production smoke test and the on-call runbook in one file. Written for
 * two questions: "is this deployment configured to send", and "has it been
 * sending". It NEVER writes — no transaction, no --commit flag, nothing to
 * undo — so it is safe against production at any time, including before the
 * code that uses these tables is deployed.
 *
 * Exits 0 when everything needed is in place, 1 when something needs a human.
 * Every failing check prints the next command, because several of them are
 * ordering-sensitive and a half-configured mailer is the state most likely to
 * send 500 messages nobody can use.
 *
 * ENV VAR VALUES ARE NEVER PRINTED — only whether a name is set. This output
 * is the thing somebody pastes into a chat when asking for help.
 */
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

const problems = [];
const warnings = [];

function ok(label, detail = '') {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label, fix) {
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  if (fix) console.log(`      → ${fix}`);
  problems.push(label);
}
function warn(label, detail = '') {
  console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  warnings.push(label);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Nothing to check.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl:
    process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
});

await client.connect();

const q = async (sql, params = []) => (await client.query(sql, params)).rows;

console.log('\n\x1b[1mSchema\x1b[0m');

const tables = await q(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('email_outbox','email_suppressions',
                         'user_email_preferences','password_reset_tokens')`,
);
const present = new Set(tables.map((t) => t.table_name));
for (const t of [
  'email_outbox',
  'email_suppressions',
  'user_email_preferences',
  'password_reset_tokens',
]) {
  if (present.has(t)) ok(t);
  else bad(`${t} is missing`, 'Migration 0037 has not run. Restart the API.');
}

const col = await q(
  `SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'email_announcements'`,
);
if (col.length) ok('organizations.email_announcements');
else bad('organizations.email_announcements is missing', 'Migration 0037 has not run.');

/**
 * pg-boss creates its own schema on first start. Its ABSENCE is the single
 * clearest signal that the worker has never successfully booted — which is
 * also the failure mode nothing else reveals, because the API carries on
 * queueing mail perfectly while nothing drains it.
 */
const boss = await q(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'`);
if (boss.length) ok('pgboss schema');
else
  bad(
    'pgboss schema is missing — the worker has never started',
    'pm2 start ecosystem.config.js   (or: WORKER=1 node dist/main)',
  );

console.log('\n\x1b[1mConfiguration\x1b[0m  (names only, never values)');

const enabled = process.env.EMAIL_ENABLED === 'true';
const driver = process.env.EMAIL_DRIVER ?? 'log';

if (enabled) ok('EMAIL_ENABLED', 'true');
else warn('EMAIL_ENABLED is not true', 'nothing is being queued or sent');

ok('EMAIL_DRIVER', driver);

if (driver === 'gmail') {
  if (process.env.EMAIL_FROM) ok('EMAIL_FROM', 'set');
  else bad('EMAIL_FROM is not set', 'Set it to the sending mailbox and restart.');

  const hasServiceAccount = Boolean(process.env.GMAIL_SERVICE_ACCOUNT_KEY);
  const hasRefresh =
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN;

  if (hasServiceAccount) {
    ok('GMAIL_SERVICE_ACCOUNT_KEY', 'set — no refresh token needed, nothing to expire');
    if (process.env.GMAIL_IMPERSONATE) ok('GMAIL_IMPERSONATE', 'set');
    else
      bad(
        'GMAIL_IMPERSONATE is not set',
        'A service account has no mailbox of its own — set the address it sends AS.',
      );
  } else if (hasRefresh) {
    ok('GMAIL_REFRESH_TOKEN', 'set');
    /*
     * The single likeliest way this integration dies quietly, so it is a
     * warning on every run rather than a line in a README. While the OAuth
     * consent screen is in Testing, Google expires refresh tokens after 7
     * days — mail stops a week after launch with invalid_grant.
     */
    warn(
      'Using a refresh token',
      'if the OAuth consent screen is still in "Testing", this expires after '
        + '7 DAYS. Publish the app, or move to a service account.',
    );
  } else {
    bad(
      'No Gmail credential',
      'A client id and secret alone cannot send. Run '
        + '`npm run email:gmail-authorize` to mint a refresh token, or set '
        + 'GMAIL_SERVICE_ACCOUNT_KEY.',
    );
  }

  /*
   * Gmail is a far smaller pipe than SES. Worth catching here rather than
   * when a fan-out hits the wall halfway through.
   */
  const ceiling = Number(process.env.GMAIL_DAILY_CEILING ?? 2000);
  const perDay = Number(process.env.EMAIL_MAX_PER_DAY ?? 200);
  if (perDay > ceiling) {
    warn(
      `EMAIL_MAX_PER_DAY (${perDay}) is above the Gmail ceiling (${ceiling})`,
      'Google will start refusing partway through a fan-out.',
    );
  } else {
    ok('Daily cap', `${perDay} within the Gmail ceiling of ${ceiling}`);
  }
}

if (driver === 'ses') {
  for (const name of ['EMAIL_FROM', 'SES_REGION']) {
    if (process.env[name]) ok(name, 'set');
    else bad(`${name} is not set`, `Set ${name} in server/.env and restart.`);
  }
  if (process.env.SES_CONFIGURATION_SET) ok('SES_CONFIGURATION_SET', 'set');
  else
    warn(
      'SES_CONFIGURATION_SET is not set',
      'account-level bounce/complaint suppression will not apply',
    );

  /**
   * There is no SES_ACCESS_KEY_ID to check — the SDK's own chain resolves
   * AWS_* then the instance role. Warning when a key IS present is still
   * worth it, because on EC2 one is almost always unnecessary.
   */
  if (process.env.AWS_ACCESS_KEY_ID) {
    warn('AWS_ACCESS_KEY_ID is set', 'an EC2 instance role would avoid a key on disk');
  } else {
    ok('No AWS key in the environment', 'the SDK will use the instance role');
  }

  /**
   * The highest-consequence check in this file.
   *
   * Every `link` on a notification is relative, and CLIENT_ORIGIN defaults
   * to localhost. Under the SES driver a wrong origin means a fan-out of
   * real emails whose every link is dead — and an email cannot be recalled.
   * The worker refuses to send in this state; this is how you find out
   * BEFORE wondering why nothing is going out.
   */
  const origin = process.env.CLIENT_ORIGIN ?? '';
  if (!origin) {
    bad('CLIENT_ORIGIN is not set', 'Every link in every email would be broken.');
  } else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(origin)) {
    bad(
      `CLIENT_ORIGIN is ${origin} — not a public address`,
      'The worker will refuse to send. Set it to the public UI origin and restart.',
    );
  } else {
    ok('CLIENT_ORIGIN', origin);
  }

  const allowlist = (process.env.EMAIL_ALLOWLIST ?? '').split(',').filter(Boolean);
  if (allowlist.length) {
    ok('EMAIL_ALLOWLIST', `${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'} — dry run`);
  } else {
    warn('EMAIL_ALLOWLIST is empty', 'real learners will receive mail');
  }
}

ok('EMAIL_RATE_PER_SECOND', process.env.EMAIL_RATE_PER_SECOND ?? '1 (default)');
ok('EMAIL_MAX_PER_DAY', process.env.EMAIL_MAX_PER_DAY ?? '200 (default)');

if (present.has('email_outbox')) {
  console.log('\n\x1b[1mTraffic\x1b[0m  (last 24h)');

  const counts = await q(
    `SELECT status, COUNT(*)::int AS n FROM email_outbox
      WHERE enqueued_at > NOW() - INTERVAL '24 hours' GROUP BY status ORDER BY status`,
  );
  if (counts.length === 0) console.log('  (nothing enqueued)');
  for (const row of counts) console.log(`  ${row.status.padEnd(11)} ${row.n}`);

  /**
   * The dead-worker alarm.
   *
   * Everything else here can look healthy while the worker is down: the API
   * keeps queueing, the config is still right, the tables still exist. The
   * only symptom is the oldest pending row getting older, so it is checked
   * explicitly rather than left to be noticed.
   */
  const [oldest] = await q(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at)))::int AS age
       FROM email_outbox WHERE status = 'pending'`,
  );
  const age = oldest?.age ?? null;
  if (age === null) {
    ok('No pending mail');
  } else if (age > 1800) {
    bad(
      `Oldest pending email is ${Math.round(age / 60)} minutes old`,
      'The worker is not draining. Check: pm2 logs edstellar_lms_worker',
    );
  } else {
    ok('Queue is moving', `oldest pending ${age}s`);
  }

  const [stuck] = await q(
    `SELECT COUNT(*)::int AS n FROM email_outbox
      WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '15 minutes'`,
  );
  if (stuck.n > 0) {
    warn(`${stuck.n} row(s) stuck in 'sending'`, 'the reaper returns these within 10 minutes');
  }

  const [supp] = await q(`SELECT COUNT(*)::int AS n FROM email_suppressions`);
  if (supp.n > 0) warn(`${supp.n} suppressed address(es)`, 'hard bounces and complaints');
  else ok('No suppressed addresses');

  const errors = await q(
    `SELECT DISTINCT ON (last_error) last_error, MAX(enqueued_at) AS seen
       FROM email_outbox
      WHERE last_error IS NOT NULL AND status IN ('failed','pending')
      GROUP BY last_error ORDER BY last_error, seen DESC LIMIT 10`,
  );
  if (errors.length) {
    console.log('\n\x1b[1mRecent distinct errors\x1b[0m');
    for (const e of errors) console.log(`  • ${String(e.last_error).slice(0, 140)}`);
  }
}

await client.end();

console.log('');
if (problems.length) {
  console.log(`\x1b[31m${problems.length} problem(s) need a human.\x1b[0m`);
  process.exit(1);
}
console.log(
  warnings.length
    ? `\x1b[33mOK, with ${warnings.length} warning(s).\x1b[0m`
    : '\x1b[32mAll checks passed.\x1b[0m',
);
process.exit(0);
