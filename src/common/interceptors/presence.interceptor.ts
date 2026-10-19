import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Observable } from 'rxjs';

import { DatabaseService } from '@/database/database.service';

/**
 * Records when a person was last seen, for the Messages presence dot (0055).
 *
 * Global, and runs after the guards so `request.user` is populated — a
 * `@Public` request has none and is skipped. The write is:
 *
 *  - THROTTLED in memory, per user, to once per `TOUCH_EVERY_MS`, so a learner
 *    polling Messages every 15s costs one UPDATE a minute, not four. The map
 *    is per-process and need not survive a restart — presence is approximate.
 *  - BEST-EFFORT: fired without awaiting and with its own catch, so a slow or
 *    failed presence write can never delay or fail the actual request (§8.4).
 *
 * It is last-SEEN, not last learning activity: it fires on ANY authenticated
 * request, so "Available" means the person is around now.
 */
@Injectable()
export class PresenceInterceptor implements NestInterceptor {
  private static readonly TOUCH_EVERY_MS = 60_000;
  private readonly lastTouch = new Map<number, number>();

  constructor(private readonly database: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      user?: { userId?: number };
    }>();
    const userId = request.user?.userId;

    if (userId) {
      const now = Date.now();
      const last = this.lastTouch.get(userId) ?? 0;
      if (now - last > PresenceInterceptor.TOUCH_EVERY_MS) {
        this.lastTouch.set(userId, now);
        void this.touch(userId);
      }
    }

    return next.handle();
  }

  private async touch(userId: number): Promise<void> {
    try {
      await this.database.db.all(
        sql`UPDATE users SET last_seen_at = now() WHERE id = ${userId}`,
      );
    } catch {
      // Presence is cosmetic — never let it surface or retry.
    }
  }
}
