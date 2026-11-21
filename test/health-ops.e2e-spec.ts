/**
 * Operations (CONTEXT.md §16): the public health check an uptime monitor and
 * the worker's API watch both read.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, fixtures, signIn } from './helpers';

describe('health', () => {
  let app: NestExpressApplication;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('answers 200 { ok: true } without sign-in, and sets no cookie', async () => {
    const r = await anon(app).get('/api/health').expect(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('answers the same for a signed-in caller, and carries the security headers', async () => {
    const learner = await signIn(app, fixtures().A.learner);
    const r = await learner.get('/api/health').expect(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
