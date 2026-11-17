import { SetMetadata } from '@nestjs/common';

/**
 * Request rate limiting: the rule vocabulary, the decorator, and the counter.
 *
 * ## Why it is written here and not `@nestjs/throttler`
 *
 * The KEY is the whole design, and the library's default key is the caller's
 * IP. Our learners sign in from corporate networks, where hundreds of people
 * share one public address, so a per-IP budget on authenticated traffic would
 * lock a whole client out at 9am. So:
 *
 * - an authenticated request is counted per USER;
 * - a public request is counted per IP, with budgets sized for a shared NAT;
 * - sign-in is counted per IP + EMAIL (the brute-force unit) as well as a
 *   looser per-IP ceiling (the password-spraying unit).
 *
 * ## What it does not promise
 *
 * Counters live in process memory. The API runs as ONE process today; a
 * second instance would give each its own budget (a limit of N becomes N x
 * instances), and a restart clears them. Both only loosen the limit, never
 * refuse a legitimate caller. Moving the counters to Postgres or Redis is the
 * change to make when the API is scaled out.
 */

export type RateLimitKey = 'ip' | 'user' | 'ip+email';

export interface RateLimitRule {
  /** Distinguishes two rules on one route in the counter key and the log. */
  name: string;
  by: RateLimitKey;
  limit: number;
  windowSeconds: number;
  /** The sentence the caller reads on a 429. */
  message?: string;
}

export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Replace the default budget on a route with these rules. Every rule must
 * pass; the first one exhausted answers 429.
 */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);

/**
 * The budget every route has unless it declares its own. Generous on purpose:
 * it is a safety net against a runaway client or a scripted flood, not a
 * product limit. 600 a minute per signed-in user is ten requests a second,
 * well above SCORM tracking, video progress and polling combined.
 */
export const DEFAULT_AUTHENTICATED_RULE: RateLimitRule = {
  name: 'default-user',
  by: 'user',
  limit: 600,
  windowSeconds: 60,
};

/** Public routes with no rule of their own (logout, register). Per IP. */
export const DEFAULT_PUBLIC_RULE: RateLimitRule = {
  name: 'default-public',
  by: 'ip',
  limit: 300,
  windowSeconds: 60,
};

export interface HitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters keyed by an opaque string. Pure and synchronous, so it
 * is unit-tested without a server. `now` is injectable for the same reason.
 */
export class RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  hit(key: string, limit: number, windowMs: number, now = Date.now()): HitResult {
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - w.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    };
  }

  /** Drop expired windows at most once a minute, so memory tracks live keys. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  /** For tests. */
  get size(): number {
    return this.windows.size;
  }
}

/**
 * The caller's address. Cloudflare's `CF-Connecting-IP` first, then the first
 * `X-Forwarded-For` hop (nginx), then the socket. The same order the audit log
 * uses, plus the Cloudflare header, which is the one Cloudflare guarantees.
 *
 * A caller reaching the origin directly could forge either header and so pick
 * its own bucket. That defeats a per-IP limit, never a per-user one, and is
 * closed by letting only Cloudflare's ranges reach the origin.
 */
export function clientIp(request: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}): string {
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim() || undefined;
  return (
    first(request.headers['cf-connecting-ip']) ??
    first(request.headers['x-forwarded-for']) ??
    request.ip ??
    'unknown'
  );
}
