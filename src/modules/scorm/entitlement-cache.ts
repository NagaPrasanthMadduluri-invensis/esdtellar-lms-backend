import { Injectable } from '@nestjs/common';

/**
 * In-process TTL cache for SCORM entitlement checks (`multi-tenancy.md` §3.9).
 *
 * One SCORM launch pulls 50-200 static assets. Without this cache, every one
 * of them would cost a database round trip — a textbook §7.1 violation of
 * `BACKEND_STRUCTURE.md`. With it, the first asset in a launch pays one
 * query; the rest are served from memory for the life of the entry.
 *
 * TRADE-OFF — written down on purpose, not discovered later. The two
 * directions are deliberately asymmetric:
 *
 *   - A cached POSITIVE ("entitled") result lives for `POSITIVE_TTL_MS`
 *     (60s). Revoking an assignment, deactivating a package, or demoting an
 *     admin to a learner mid-session all keep serving cached content to an
 *     already-launched player for up to 60 seconds after the change. That is
 *     judged acceptable for static SCORM asset bytes; it must not be reused
 *     as a pattern anywhere a capability (rather than a page or an image) is
 *     granted.
 *   - A cached NEGATIVE ("not entitled") result lives for the much shorter
 *     `NEGATIVE_TTL_MS`. A learner who opened a lesson before being assigned
 *     would otherwise see "unavailable" for up to a minute AFTER an admin
 *     assigns them — precisely the moment someone is watching — so a stale
 *     "no" is not given the same 60s life as a stale "yes".
 *
 * Hand-rolled rather than an LRU package: `server/package.json` carries no
 * such dependency today, and a single size-capped map does not warrant
 * adding one. Map iteration order is insertion order in V8, which is what
 * lets eviction below pick the oldest entry without tracking anything extra.
 */
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 2_000;
const MAX_ENTRIES = 5_000;

interface CacheEntry {
  entitled: boolean;
  expiresAt: number;
}

@Injectable()
export class EntitlementCache {
  private readonly store = new Map<string, CacheEntry>();

  /** Returns the cached verdict, or `null` on a miss (absent or expired). */
  get(userId: number, packageDir: string): boolean | null {
    const key = this.key(userId, packageDir);
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.entitled;
  }

  set(userId: number, packageDir: string, entitled: boolean): void {
    const key = this.key(userId, packageDir);
    const ttl = entitled ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;

    // Evict the single oldest entry once the cap is hit, so a wide fan-out of
    // distinct (user, package) pairs cannot grow this map unbounded.
    if (this.store.size >= MAX_ENTRIES && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }

    this.store.set(key, { entitled, expiresAt: Date.now() + ttl });
  }

  private key(userId: number, packageDir: string): string {
    return `${userId}:${packageDir}`;
  }
}
