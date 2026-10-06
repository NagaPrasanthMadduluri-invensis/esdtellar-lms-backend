/**
 * Mints a Gmail refresh token for the sending mailbox. ONE-OFF, INTERACTIVE.
 *
 *   node scripts/gmail-authorize.mjs
 *
 * A client id and secret cannot send mail on their own. They identify the
 * APPLICATION; they say nothing about which mailbox it may act as. The
 * missing half is a refresh token, and getting one requires a human to sign
 * in as that mailbox once and consent. This script is that once.
 *
 * ## Before it will work
 *
 * The OAuth client needs this exact redirect URI registered, in Google Cloud
 * Console -> APIs & Services -> Credentials -> your OAuth 2.0 Client ID:
 *
 *     http://localhost:53682/
 *
 * The credentials file this project was given has NO redirect URIs at all,
 * so the consent screen will refuse with `redirect_uri_mismatch` until one
 * is added. That is a console change, not a code change.
 *
 * The Gmail API must also be enabled on the project.
 *
 * ## THE SEVEN-DAY TRAP
 *
 * While the OAuth consent screen's publishing status is **Testing**, Google
 * expires refresh tokens after SEVEN DAYS. Mail then stops a week after
 * go-live with `invalid_grant`, long after anybody is still watching the
 * deploy. Set the consent screen to **In production** before relying on
 * this. The script re-states it at the end, because it is the single
 * likeliest way this integration fails quietly.
 *
 * ## The alternative, which does not expire
 *
 * A service account with domain-wide delegation needs no refresh token and
 * no human: a Workspace super-admin authorises the service account's client
 * id for `https://www.googleapis.com/auth/gmail.send`, and the server
 * impersonates the mailbox. Prefer it for an unattended sender; this script
 * exists because an OAuth web client is what most people already have.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/* Credentials: a client_secret_*.json path as argv[2], or the env vars. */
function credentials() {
  const path = process.argv[2];
  if (path) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const block = parsed.web ?? parsed.installed;
    if (!block?.client_id || !block?.client_secret) {
      console.error(
        'That file has no web/installed client_id + client_secret.\n'
        + 'A SERVICE ACCOUNT key is a different thing — it has "type": '
        + '"service_account" — and needs no refresh token at all. Set '
        + 'GMAIL_SERVICE_ACCOUNT_KEY instead of running this.',
      );
      process.exit(1);
    }
    return { id: block.client_id, secret: block.client_secret };
  }

  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.error(
      'Pass the client_secret_*.json as an argument, or set GMAIL_CLIENT_ID '
      + 'and GMAIL_CLIENT_SECRET in server/.env.',
    );
    process.exit(1);
  }
  return { id: process.env.GMAIL_CLIENT_ID, secret: process.env.GMAIL_CLIENT_SECRET };
}

const { id, secret } = credentials();
/* CSRF guard: Google echoes this back and we refuse anything else. */
const state = randomBytes(16).toString('hex');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?'
  + new URLSearchParams({
    client_id: id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // Both are required to be GIVEN a refresh token. `offline` asks for
    // one; `consent` forces the prompt even if this account has already
    // approved the app — without it a second run returns an access token
    // and no refresh token, which looks like the script is broken.
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

console.log('\n1. Open this URL and sign in AS THE SENDING MAILBOX');
console.log('   (spectralms@edstellar.com — not your own account):\n');
console.log(`   ${authUrl}\n`);
console.log(`2. Waiting for the redirect on ${REDIRECT} …\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const reply = (msg) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem">${msg}</body>`);
  };

  const error = url.searchParams.get('error');
  if (error) {
    reply(`<h2>Refused: ${error}</h2><p>Check the terminal.</p>`);
    console.error(`\nGoogle refused: ${error}`);
    if (error === 'redirect_uri_mismatch') {
      console.error(`Add ${REDIRECT} to the OAuth client's Authorised redirect URIs.`);
    }
    server.close(); process.exit(1);
  }

  if (url.searchParams.get('state') !== state) {
    reply('<h2>State mismatch — ignored.</h2>');
    console.error('\nstate did not match; refusing.');
    server.close(); process.exit(1);
  }

  const code = url.searchParams.get('code');
  if (!code) { reply('<h2>No code in the redirect.</h2>'); server.close(); process.exit(1); }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: id, client_secret: secret,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }),
  });
  const body = await tokenRes.json();

  if (!tokenRes.ok || !body.refresh_token) {
    reply('<h2>No refresh token returned. Check the terminal.</h2>');
    console.error('\nNo refresh_token in the response:');
    console.error(JSON.stringify(body, null, 2));
    console.error(
      '\nIf everything else looks fine, this account has already granted the '
      + 'app and Google withheld a second refresh token. Revoke it at '
      + 'https://myaccount.google.com/permissions and run this again.',
    );
    server.close(); process.exit(1);
  }

  reply('<h2>Done.</h2><p>The refresh token is in your terminal. You can close this tab.</p>');

  console.log('Add these to server/.env on the box (NOT to git):\n');
  console.log('  EMAIL_DRIVER=gmail');
  console.log('  EMAIL_FROM=spectralms@edstellar.com');
  console.log(`  GMAIL_CLIENT_ID=${id}`);
  console.log('  GMAIL_CLIENT_SECRET=<the secret you already have>');
  console.log(`  GMAIL_REFRESH_TOKEN=${body.refresh_token}`);
  console.log('\nThen: sudo pm2 restart edstellar_lms_worker --update-env');
  console.log('      npm run email:verify\n');
  console.log('REMEMBER: while the OAuth consent screen is in "Testing", this');
  console.log('token expires in SEVEN DAYS. Publish the app before relying on it.\n');

  server.close();
  process.exit(0);
});

server.listen(PORT);
