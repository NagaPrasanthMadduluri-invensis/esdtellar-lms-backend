import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, fixtures, signIn } from './helpers';

describe('e2e harness smoke', () => {
  let app: NestExpressApplication;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('health answers without sign-in', async () => {
    await anon(app).get('/api/health').expect(200);
  });

  it('every fixture role can sign in and gets the right portal', async () => {
    const fx = fixtures();
    const cases: [typeof fx.A.admin, string][] = [
      [fx.platform.admin, 'admin'], [fx.A.admin, 'admin'], [fx.A.manager, 'learner'],
      [fx.A.learner, 'learner'], [fx.A.trainer, 'trainer'], [fx.B.admin, 'admin'],
    ];
    for (const [who, portal] of cases) {
      const agent = await signIn(app, who);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(me.body.user.role).toBe(portal);
    }
  });
});
