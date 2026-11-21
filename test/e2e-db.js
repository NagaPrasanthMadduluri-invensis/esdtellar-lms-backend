/**
 * The e2e database: a throwaway Postgres that is never the dev database.
 *
 * Locally it is a Docker container (postgres:18-alpine) on 127.0.0.1:5436,
 * started on demand. In CI, set E2E_DATABASE_URL to the job's service
 * container and Docker is not used. Either way the database name MUST end in
 * `_e2e`: `reset()` refuses anything else, because it drops every table.
 *
 * Plain CommonJS so both Jest (server) and Playwright (client) can load it.
 */
const { execSync } = require('node:child_process');
const { Client } = require('pg');

const PORT = Number(process.env.E2E_DB_PORT || 5436);
const CONTAINER = PORT === 5436 ? 'edstellar-lms-e2e-db' : `edstellar-lms-e2e-db-${PORT}`;
const DEFAULT_URL = `postgresql://e2e:e2e@127.0.0.1:${PORT}/edstellar_lms_e2e`;

function url() {
  return process.env.E2E_DATABASE_URL || DEFAULT_URL;
}

function docker(cmd) {
  try {
    return execSync(`docker ${cmd}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    // The tool shell may predate the docker group; `sg` needs no password.
    if (String(e.stderr || '').includes('permission denied')) {
      return execSync(`sg docker -c ${JSON.stringify(`docker ${cmd}`)}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    }
    throw e;
  }
}

async function canConnect() {
  const c = new Client({ connectionString: url() });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

async function ensureUp() {
  if (await canConnect()) return url();
  if (process.env.E2E_DATABASE_URL) throw new Error(`E2E_DATABASE_URL is set but not reachable: ${redact(url())}`);
  const state = docker(`ps -a --filter name=^${CONTAINER}$ --format "{{.State}}"`);
  if (!state) {
    docker(`run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:5432 -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=edstellar_lms_e2e --tmpfs /var/lib/postgresql postgres:18-alpine`);
  } else if (state !== 'running') {
    docker(`start ${CONTAINER}`);
  }
  for (let i = 0; i < 60; i++) {
    if (await canConnect()) return url();
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('e2e Postgres did not become ready in 30s');
}

/** Drop and recreate every schema the app uses. Refuses a non-_e2e database. */
async function reset() {
  const dbName = new URL(url()).pathname.slice(1);
  if (!dbName.endsWith('_e2e')) throw new Error(`Refusing to reset "${dbName}": the e2e database name must end in _e2e`);
  const c = new Client({ connectionString: url() });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE;');
    // Build from the schema snapshot (see snapshot-schema.js for why); the app
    // then re-applies every migration on boot, as dev and production do.
    await c.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'schema.sql'), 'utf8'));
  } finally {
    await c.end();
  }
}

function stop() {
  try {
    docker(`rm -f ${CONTAINER}`);
  } catch {}
}

const redact = (u) => u.replace(/\/\/[^@]*@/, '//***@');

module.exports = { url, ensureUp, reset, stop, redact };

if (require.main === module) {
  const cmd = process.argv[2] || 'up';
  (async () => {
    if (cmd === 'up') console.log('e2e db ready:', redact(await ensureUp()));
    else if (cmd === 'reset') { await ensureUp(); await reset(); console.log('e2e db reset'); }
    else if (cmd === 'down') { stop(); console.log('e2e db removed'); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
