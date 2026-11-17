import type { NextFunction, Request, Response } from 'express';

/**
 * Security response headers for every API response, set by hand rather than
 * with `helmet`, because helmet's DEFAULTS break two things this API does:
 *
 * - `Cross-Origin-Resource-Policy: same-origin` would stop the browser loading
 *   avatars, attachments and certificate files from the API origin
 *   (lms-api.edstellar.com) into pages on the app origin (spectralms...).
 *   Those are SAME-SITE, so `same-site` is the right value.
 * - Its `Content-Security-Policy` (`script-src 'self'`, no inline) would apply
 *   to SCORM packages, which this API serves under /scorm and which are full of
 *   inline script and eval. They would stop tracking silently (§10.1).
 *
 * What is set, and why each is safe here:
 *
 * | Header | Value |
 * |---|---|
 * | X-Content-Type-Options | nosniff: a file is only ever what its type says |
 * | Content-Security-Policy | `frame-ancestors` ONLY: the API itself and the app origins (CLIENT_ORIGIN) |
 * | Referrer-Policy | no-referrer: an API response has nothing to tell the next site |
 * | Cross-Origin-Resource-Policy | same-site, see above |
 * | Permissions-Policy | camera, microphone, geolocation, payment off |
 * | Strict-Transport-Security | only when the request arrived over HTTPS |
 *
 * Framing is limited with `frame-ancestors`, not `X-Frame-Options`, because
 * the app DOES frame API responses across origins: a PDF lesson is an iframe
 * of `<api>/api/learner/lessons/:id/document` inside a page on the app origin.
 * `X-Frame-Options: SAMEORIGIN` would blank every PDF lesson, and it cannot
 * name a second origin. A CSP carrying only `frame-ancestors` restricts who
 * may frame us and nothing else, so it is also safe on SCORM content.
 *
 * HSTS is conditional because it is meaningless over plain HTTP and a
 * developer's localhost must not be pinned. Behind Cloudflare and nginx the
 * scheme arrives as `X-Forwarded-Proto`.
 *
 * `X-Powered-By: Express` is removed in main.ts (`app.disable`).
 */
export function securityHeaders(clientOrigins: string[]) {
  const frameAncestors = ["'self'", ...clientOrigins].join(' ');
  return (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      `frame-ancestors ${frameAncestors}`,
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    const proto = request.headers['x-forwarded-proto'];
    const https =
      request.secure ||
      (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0].trim() ===
        'https';
    if (https) {
      response.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
    next();
  };
}
