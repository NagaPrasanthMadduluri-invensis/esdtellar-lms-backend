import type { CookieOptions } from 'express';

/**
 * Options for the auth cookie.
 *
 * `httpOnly` is the whole point of the move: the legacy client wrote the token
 * with `document.cookie`, so any script on the page could read it. Nothing in
 * client JavaScript can see this cookie — it is attached by the browser and
 * read only by the server.
 *
 * SameSite=Lax is correct for the intended deployments because "site" ignores
 * the port: localhost:3000 -> localhost:3001 in development, and
 * app.example.com -> api.example.com under a shared COOKIE_DOMAIN in
 * production, are both same-site. A genuinely cross-site split (different
 * registrable domains) would need SameSite=None with Secure, which also
 * requires HTTPS on both origins.
 */
export function authCookieOptions(opts: {
  maxAgeSeconds: number;
  domain: string;
  isProduction: boolean;
}): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.isProduction,
    path: '/',
    // Browsers treat an explicit `domain=localhost` inconsistently; omitting it
    // yields a host-only cookie, which is what we want in development.
    ...(opts.domain && opts.domain !== 'localhost'
      ? { domain: opts.domain }
      : {}),
    maxAge: opts.maxAgeSeconds * 1000,
  };
}

/** Clearing must repeat the same attributes or the browser keeps the cookie. */
export function clearCookieOptions(opts: {
  domain: string;
  isProduction: boolean;
}): CookieOptions {
  const { maxAge: _maxAge, ...rest } = authCookieOptions({
    maxAgeSeconds: 0,
    domain: opts.domain,
    isProduction: opts.isProduction,
  });
  return rest;
}
