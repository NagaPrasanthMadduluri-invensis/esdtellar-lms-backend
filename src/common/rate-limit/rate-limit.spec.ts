import { Reflector } from '@nestjs/core';
import { HttpException } from '@nestjs/common';

import { RateLimitGuard } from '../guards/rate-limit.guard';
import { RATE_LIMIT_KEY, RateLimitStore, clientIp, type RateLimitRule } from './rate-limit';

describe('RateLimitStore', () => {
  it('allows up to the limit in a window, then refuses with a retry time', () => {
    const store = new RateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(store.hit('k', 3, 60_000, t0).allowed).toBe(true);
    const refused = store.hit('k', 3, 60_000, t0 + 10_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(50);
  });

  it('starts a fresh window once the old one has expired', () => {
    const store = new RateLimitStore();
    store.hit('k', 1, 1_000, 0);
    expect(store.hit('k', 1, 1_000, 500).allowed).toBe(false);
    expect(store.hit('k', 1, 1_000, 1_000).allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const store = new RateLimitStore();
    expect(store.hit('a', 1, 1_000, 0).allowed).toBe(true);
    expect(store.hit('b', 1, 1_000, 0).allowed).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers Cloudflare, then the first forwarded hop, then the socket', () => {
    expect(
      clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, ip: '3.3.3.3' }),
    ).toBe('1.1.1.1');
    expect(clientIp({ headers: { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }, ip: '3.3.3.3' })).toBe('2.2.2.2');
    expect(clientIp({ headers: {}, ip: '3.3.3.3' })).toBe('3.3.3.3');
  });
});

describe('RateLimitGuard', () => {
  const ctx = (
    request: Record<string, unknown>,
    rules?: RateLimitRule[],
  ) => {
    const headers: Record<string, string> = {};
    const handler = () => undefined;
    if (rules) Reflect.defineMetadata(RATE_LIMIT_KEY, rules, handler);
    return {
      context: {
        getType: () => 'http',
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => ({ method: 'POST', path: '/x', headers: {}, ...request }),
          getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }),
        }),
      } as never,
      headers,
    };
  };

  it('counts sign-in per address AND email, so another account is unaffected', () => {
    const guard = new RateLimitGuard(new Reflector());
    const rule: RateLimitRule = { name: 'login', by: 'ip+email', limit: 2, windowSeconds: 60 };
    const as = (email: string) => ctx({ ip: '9.9.9.9', body: { email } }, [rule]);
    expect(guard.canActivate(as('A@x.com').context)).toBe(true);
    expect(guard.canActivate(as('a@x.com ').context)).toBe(true);
    const third = as('a@x.com');
    expect(() => guard.canActivate(third.context)).toThrow(HttpException);
    expect(third.headers['Retry-After']).toBeDefined();
    expect(guard.canActivate(as('b@x.com').context)).toBe(true);
  });

  it('counts a signed-in caller per user, so colleagues on one network do not share a budget', () => {
    const guard = new RateLimitGuard(new Reflector());
    const rule: RateLimitRule = { name: 'u', by: 'user', limit: 1, windowSeconds: 60 };
    const as = (userId: number) => ctx({ ip: '9.9.9.9', user: { userId } }, [rule]).context;
    expect(guard.canActivate(as(1))).toBe(true);
    expect(guard.canActivate(as(2))).toBe(true);
    expect(() => guard.canActivate(as(1))).toThrow(HttpException);
  });

  it('answers 429 with a sentence that says when to retry', () => {
    const guard = new RateLimitGuard(new Reflector());
    const rule: RateLimitRule = {
      name: 'v', by: 'ip', limit: 0, windowSeconds: 600, message: 'Too many lookups.',
    };
    try {
      guard.canActivate(ctx({ ip: '1.2.3.4' }, [rule]).context);
      throw new Error('expected a refusal');
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(429);
      expect((err.getResponse() as { message: string }).message).toMatch(
        /^Too many lookups\. Please try again in 10 minutes\.$/,
      );
    }
  });
});
