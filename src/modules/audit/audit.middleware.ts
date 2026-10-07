import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedRequest } from '@/common/types/authenticated-request';

import { AuditService } from './audit.service';
import type { NewAuditEntry } from './audit.repository';

/** Only these change something. A GET is a read and is not recorded. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ACTION_BY_METHOD: Record<string, string> = {
  POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete',
};

/**
 * Where the exception filter leaves the message, for the finish handler to
 * pick up. A symbol rather than a string key so it cannot collide with
 * anything Express or a library puts on the request.
 */
export const AUDIT_ERROR = Symbol('auditError');

/**
 * Where a `@Public()` handler leaves the person it just identified.
 *
 * The middleware reads `request.user`, which `AuthGuard` populates — and on
 * a public route there is none, by definition. That is correct for a
 * password-reset link and wrong for a LOGIN, which is the single event an
 * admin most wants in an activity log and which produced rows attributed to
 * "Unauthenticated" with a NULL organization, so the org-scoped read
 * excluded them entirely. A tenant could not see its own sign-ins.
 *
 * So the auth service says who it found, succeed or fail. A failed attempt
 * against a real address is still attributed to that person's organization,
 * because "somebody tried to sign in as Priya and got the password wrong"
 * is the row that matters; an attempt against an address that exists
 * nowhere stays unattributed, which is the truth.
 */
export const AUDIT_ACTOR = Symbol('auditActor');

/** What a public handler may declare about who was acting. */
export interface AuditActor {
  userId?: number | null;
  organizationId?: number | null;
  name?: string | null;
  email?: string | null;
  portal?: string | null;
}

/**
 * Routes recorded as the event without their body, or not at all.
 *
 *  - VOLUME. The SCORM data-model log emits thousands of deltas per sitting
 *    (§10.9 calls it the hottest write path in the system). One audit row
 *    per batch would bury every human action in the table.
 *  - NOISE. Marking a notification read is not an action anybody audits.
 */
const SKIP_ROUTES = [
  /\/learner\/scorm\/[^/]+\/datamodel$/,
  /\/learner\/scorm\/[^/]+\/(commit|track)$/,
  /\/notifications(\/[^/]*)?\/?(read)?$/,
  /\/email\/ses-events$/,
  /\/lessons\/[^/]+\/video-progress$/,
];

/**
 * Keys never written to the table, at any depth.
 *
 * Not hypothetical: three routes carry a password (`login`,
 * `change-password`, `reset-password`), the bulk import carries up to 500 of
 * them, and two more carry a reset token. An audit log that stores a
 * credential is a bigger liability than no audit log. The match is a
 * SUBSTRING test on the lower-cased key, so `newPassword`,
 * `current_password` and `passwordHash` are caught without listing them.
 */
const REDACT = [
  'password', 'token', 'secret', 'authorization', 'cookie',
  'client_id', 'refresh', 'credential', 'otp', 'pin',
];

const MAX_SUMMARY_BYTES = 4000;
const MAX_ARRAY_ITEMS = 5;

/**
 * Records every mutating request, in one place, for ever.
 *
 * ## Why MIDDLEWARE and not an interceptor
 *
 * This was written as a `NestInterceptor` first, and it was wrong in a way
 * that only testing showed: **Nest runs guards BEFORE interceptors**, so a
 * request refused by `RolesGuard`, `PermissionsGuard` or
 * `PlatformAdminGuard` never reaches one. Measured — a tenant admin POSTing
 * to a `@PlatformAdmin()` route got its 403 and wrote no row at all.
 *
 * That is not a gap at the edge, it is half the point. "Who tried to reach
 * the billing routes" is exactly the question an audit log is opened for,
 * and an audit log of successes cannot answer it. A request that never
 * matched a route (404 from the router) was invisible for the same reason.
 *
 * Middleware runs FIRST, before every guard, and `res.on('finish')` fires
 * after the response is written whatever produced it — handler, guard,
 * filter or router. By then `request.user` and `request.route` have been
 * populated by whatever got that far, so the late read costs nothing and
 * gains the refusals.
 *
 * ## What it still does not promise
 *
 * The row is written after the response, not inside the handler's
 * transaction, so a crash in that gap loses it. Far narrower than
 * best-effort, and not the same as guaranteed. `0043`'s header says so too.
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuditMiddleware.name);

  constructor(private readonly audit: AuditService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (!MUTATING.has(request.method)) return next();

    const path = request.originalUrl?.split('?')[0] ?? request.url;
    if (SKIP_ROUTES.some((re) => re.test(path))) return next();

    const started = Date.now();

    /*
     * The body is captured BEFORE anything downstream runs.
     *
     * Not tidiness: the global ValidationPipe transforms `request.body` in
     * place and a service is free to mutate it further, so reading it in the
     * finish handler can record something the caller never sent — which is
     * the one thing an audit log must not do.
     */
    const summary = this.summarise(request.body);

    response.on('finish', () => {
      void this.audit.record(
        this.entry({ request, response, path, summary, durationMs: Date.now() - started }),
      );
    });

    next();
  }

  private entry(input: {
    request: Request;
    response: Response;
    path: string;
    summary: unknown;
    durationMs: number;
  }): NewAuditEntry {
    const { request, response, path, summary, durationMs } = input;
    const user = (request as AuthenticatedRequest).user;
    const status = response.statusCode;
    /* Only consulted where the guard left nothing — a verified token always
     * wins over anything a handler claimed. */
    const declared = (request as unknown as Record<symbol, AuditActor | undefined>)[AUDIT_ACTOR];

    /*
     * The matched ROUTE PATTERN, not the path. Express fills `route.path`
     * with `/:id` placeholders, which is what makes "every update to a
     * course" one group rather than four hundred distinct strings. It is
     * absent when nothing matched, and the path is then the honest
     * fallback — a value beats a null the filter cannot group.
     */
    const pattern = (request as unknown as { route?: { path?: string } }).route?.path;
    const { entity, entityId } = this.identify(path);
    const stashed = (request as unknown as Record<symbol, unknown>)[AUDIT_ERROR];

    return {
      organizationId: user?.organizationId ?? declared?.organizationId ?? null,
      actorUserId: user?.userId ?? declared?.userId ?? null,
      actorName: user
        ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email
        /*
         * Recorded as such rather than skipped. A probe at an admin route
         * and a sign-in attempt against an address that exists nowhere are
         * both things somebody investigating wants to see, and neither has
         * a user attached.
         */
        : declared?.name || 'Unauthenticated',
      actorEmail: user?.email ?? declared?.email ?? null,
      actorPortal: user?.role ?? declared?.portal ?? null,
      actorRole: user?.scope ? String(user.scope) : null,
      impersonatorName: user?.impersonatorName ?? null,
      method: request.method,
      route: pattern ? String(pattern) : path,
      path,
      action: ACTION_BY_METHOD[request.method] ?? 'update',
      entity,
      entityId,
      statusCode: status,
      outcome: status >= 400 ? 'failure' : 'success',
      errorMessage: typeof stashed === 'string' ? stashed.slice(0, 500) : null,
      summary: summary ?? null,
      ip: this.ipOf(request),
      durationMs,
    };
  }

  /**
   * The thing acted on, derived from the path.
   *
   * The rule is: find the LAST numeric segment — that is the id — and the
   * segment before it is the collection. With no numeric segment anywhere,
   * the last segment is the collection and there is no id.
   *
   *   /api/admin/courses                     -> courses, null
   *   /api/admin/courses/12                  -> courses, 12
   *   /api/admin/courses/12/lessons          -> courses, 12
   *   /api/learner/lessons/1/complete        -> lessons, 1
   *   /api/admin/sessions/3/roster           -> sessions, 3
   *
   * The first version took the last NON-numeric segment, which filed
   * `/lessons/1/complete` under an entity called "complete" — a verb, which
   * groups nothing and reads as a thing that does not exist. Anchoring on
   * the id instead ties every action to the row it touched, which is the
   * question somebody actually asks ("what happened to course 12"), and the
   * verb is not lost: `route` still carries `/courses/:id/lessons`.
   *
   * Derived rather than declared per route, for the same reason the writer
   * is one middleware: anything that has to be extended for every new
   * endpoint is a thing with gaps nobody can see.
   */
  private identify(path: string): { entity: string | null; entityId: number | null } {
    const parts = path.split('/').filter(Boolean).filter((p) => p !== 'api');
    if (parts.length === 0) return { entity: null, entityId: null };

    let idIndex = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(parts[i])) { idIndex = i; break; }
    }

    if (idIndex > 0) {
      return { entity: parts[idIndex - 1], entityId: Number(parts[idIndex]) };
    }
    if (idIndex === 0) {
      // A bare numeric first segment names no collection at all.
      return { entity: null, entityId: Number(parts[0]) };
    }

    const last = parts[parts.length - 1];
    return { entity: last || null, entityId: null };
  }

  private ipOf(request: Request): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (first?.split(',')[0].trim() || request.ip) ?? null;
  }

  /**
   * A redacted, size-capped view of the body.
   *
   * Arrays are truncated with a COUNT kept, because the bulk import posts up
   * to 500 rows and storing them would put a copy of the whole spreadsheet
   * in this table on every upload — while "500 rows" is precisely the fact
   * somebody auditing that import wants.
   */
  private summarise(body: unknown): unknown {
    if (body === null || body === undefined) return null;
    if (typeof body !== 'object') return null;
    if (Array.isArray(body) && body.length === 0) return null;
    if (!Array.isArray(body) && Object.keys(body as object).length === 0) return null;

    const walk = (value: unknown, depth: number): unknown => {
      if (depth > 4) return '[deep]';
      if (Array.isArray(value)) {
        const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => walk(v, depth + 1));
        return value.length > MAX_ARRAY_ITEMS
          ? [...head, `… ${value.length - MAX_ARRAY_ITEMS} more of ${value.length}`]
          : head;
      }
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const key = k.toLowerCase();
          out[k] = REDACT.some((r) => key.includes(r)) ? '[redacted]' : walk(v, depth + 1);
        }
        return out;
      }
      if (typeof value === 'string' && value.length > 300) {
        return `${value.slice(0, 300)}… (${value.length} chars)`;
      }
      return value;
    };

    try {
      const walked = walk(body, 0);
      const json = JSON.stringify(walked);
      if (json && json.length > MAX_SUMMARY_BYTES) {
        return { _truncated: true, _bytes: json.length };
      }
      return walked;
    } catch {
      return { _unserialisable: true };
    }
  }
}
