#!/usr/bin/env node
/**
 * Post one line to the team's Zoho Cliq alerts channel (BACKEND_STRUCTURE 10.50).
 *
 *   node scripts/cliq-notify.mjs <info|high|critical> "<title>" ["<line>" ...]
 *
 * Used by the GitHub Actions deploy step (success or failure). Reads the
 * CLIQ_* settings from this repo's .env, so it must run on the server. Never
 * fails the caller: any problem prints a warning and exits 0, because a
 * deploy must not be reported as failed just because the alert did not post.
 */
import { readFileSync } from 'node:fs';

const env = {};
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^(CLIQ_[A-Z_]+|CLIENT_ORIGIN)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {
  console.warn('cliq-notify: no .env found; not sent.');
  process.exit(0);
}
const [level = 'info', title = 'Notice', ...lines] = process.argv.slice(2);
const tag = { critical: '🔴 CRITICAL', high: '🟠 HIGH', info: '🔵 INFO' }[level] ?? '🔵 INFO';
let host = env.CLIENT_ORIGIN?.split(',')[0] ?? '';
try { host = new URL(host).host; } catch { /* keep */ }
const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const text = [`${tag} · *${title}*`, ...lines, `_${host || 'unknown environment'} · ${when}_`].join('\n');

if (!env.CLIQ_CHANNEL_URL || !env.CLIQ_WEBHOOK_TOKEN) {
  console.warn('cliq-notify: Cliq is not configured in .env; not sent.');
  process.exit(0);
}
async function post(withBot) {
  const q = new URLSearchParams({ zapikey: env.CLIQ_WEBHOOK_TOKEN });
  if (withBot && env.CLIQ_BOT_NAME) q.set('bot_unique_name', env.CLIQ_BOT_NAME);
  return fetch(`${env.CLIQ_CHANNEL_URL}?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  });
}
try {
  let res = await post(true);
  if (res.status === 400 && (await res.text()).includes('bot_not_member')) res = await post(false);
  console.log(`cliq-notify: ${res.ok ? 'sent' : `Cliq answered ${res.status}`}`);
} catch (error) {
  console.warn(`cliq-notify: not sent (${error})`);
}
process.exit(0);
