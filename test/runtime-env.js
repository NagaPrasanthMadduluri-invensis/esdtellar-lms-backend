/**
 * The environment the e2e API runs with. The test process chdirs into
 * test/runtime/ and writes this as its `.env`, so the real server/.env (Gmail,
 * Cliq, OpenRouter, R2 credentials) is never read: no real email, alert, AI
 * call or upload can happen from a test.
 */
const path = require('node:path');
const fs = require('node:fs');

const RUNTIME_DIR = process.env.E2E_RUNTIME_DIR ? path.resolve(__dirname, '..', process.env.E2E_RUNTIME_DIR) : path.join(__dirname, 'runtime');
const COVERAGE_DIR = process.env.E2E_COVERAGE_DIR ? path.resolve(__dirname, '..', process.env.E2E_COVERAGE_DIR) : path.join(__dirname, '.coverage');
const FAKE_AI_PORT = Number(process.env.E2E_FAKE_AI_PORT || 3299);

function runtimeEnv(databaseUrl, extra = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'false',
    JWT_SECRET: 'e2e-jwt-secret-that-is-at-least-32-characters-long',
    PORT: String(process.env.E2E_API_PORT || 3201),
    CLIENT_ORIGIN: process.env.E2E_WEB_ORIGIN || 'http://localhost:3200',
    COOKIE_DOMAIN: 'localhost',
    EMAIL_ENABLED: 'true',
    EMAIL_DRIVER: 'file',
    EMAIL_ALLOWLIST: '',
    EMAIL_FROM: 'e2e@example.test',
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'e2e-fake-key',
    AI_BASE_URL: `http://127.0.0.1:${FAKE_AI_PORT}/api/v1`,
    MFA_ENCRYPTION_KEY: 'e2e0'.repeat(16),
    MFA_ENFORCE: 'true',
    RETENTION_ENABLED: 'false',
    RETENTION_DRY_RUN: 'true',
    CLIQ_WEBHOOK_TOKEN: '',
    CLIQ_CHANNEL_URL: '',
    UPLOAD_STORAGE_PATH: path.join(RUNTIME_DIR, 'uploads'),
    ...extra,
  };
}

function writeRuntime(env) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(RUNTIME_DIR, 'env.json'), JSON.stringify(env, null, 1));
}

function applyRuntime() {
  const env = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'env.json'), 'utf8'));
  Object.assign(process.env, env);
  process.chdir(RUNTIME_DIR);
  return env;
}

module.exports = { RUNTIME_DIR, COVERAGE_DIR, FAKE_AI_PORT, runtimeEnv, writeRuntime, applyRuntime };
