/**
 * The retention sweep (BACKEND_STRUCTURE §10.43, §10.48). It has no HTTP
 * route: it runs on the worker. RetentionModule is imported by WorkerModule,
 * not AppModule, so RetentionService is not in the API's graph; it is built
 * here from the same three modules the worker uses (config, database,
 * retention) against the e2e database.
 *
 * Guards respected: with the environment's RETENTION_ENABLED=false the sweep is
 * a no-op; the explicit override is exactly what `npm run retention:sweep`
 * passes, first counting (dry run) and then applying.
 */
import { ConfigModule } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import configuration from '@/config/configuration';
import { DatabaseModule } from '@/database/database.module';
import { RetentionModule } from '@/modules/retention/retention.module';
import { RetentionService } from '@/modules/retention/retention.service';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { tag, waitNotifications } from './support/5';

describe('retention sweep', () => {
  let app: NestExpressApplication;
  let worker: INestApplicationContext;
  let retention: RetentionService;
  const fx = fixtures();
  let adminA: Agent;
  let leaver: Person;
  let recentLeaver: Person;
  let fixtureSnapshot: unknown[];

  const fixtureIds = () => [fx.A.admin, fx.A.manager, fx.A.learner, fx.A.learner2, fx.A.trainer, fx.B.admin, fx.B.learner, fx.platform.admin].map((p) => p.id);
  const snapshot = () => dbQuery('SELECT id, first_name, last_name, email, is_active, anonymized_at FROM users WHERE id = ANY($1) ORDER BY id', [fixtureIds()]);
  const userRow = async (id: number) => (await dbQuery('SELECT first_name, last_name, email, phone, is_active, anonymized_at, password FROM users WHERE id = $1', [id]))[0];

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);

    // RetentionService is worker-only; try the API graph first, as the brief suggests.
    let svc: RetentionService | undefined;
    try { svc = app.get(RetentionService, { strict: false }); } catch { svc = undefined; }
    if (!svc) {
      const mod = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', load: [configuration], cache: true }), DatabaseModule, RetentionModule],
      }).compile();
      worker = await mod.init();
      svc = worker.get(RetentionService);
    }
    retention = svc;

    // A person with some identity spread around, then deactivated and backdated.
    leaver = await newPerson(adminA, fx.A);
    const me = await signIn(app, leaver);
    await me.patch('/api/auth/profile').send({ phone: '+65 9999 0000' }).expect((r) => expect(r.status).toBeLessThan(300));
    const learner = await signIn(app, fx.A.learner);
    const post = await learner.post('/api/learner/community').send({ type: 'question', title: 'Retention probe', hashtags: [tag()] }).expect(201);
    const before = (await dbQuery("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'community_reply'", [fx.A.learner.id])).length;
    await me.post(`/api/learner/community/${post.body.post.id}/replies`).send({ body: 'From the leaver' }).expect(201);
    await waitNotifications(fx.A.learner.id, 'community_reply', before + 1);
    await me.post('/api/learner/community').send({ type: 'question', title: 'Leaver question', hashtags: [tag()] }).expect(201);

    await adminA.patch(`/api/admin/users/${leaver.id}`).send({ is_active: false }).expect((r) => expect(r.status).toBeLessThan(300));
    await dbQuery("UPDATE users SET deactivated_at = now() - interval '400 days' WHERE id = $1", [leaver.id]);

    // Deactivated today: inside the window, must be left alone.
    recentLeaver = await newPerson(adminA, fx.A);
    await adminA.patch(`/api/admin/users/${recentLeaver.id}`).send({ is_active: false }).expect((r) => expect(r.status).toBeLessThan(300));

    fixtureSnapshot = await snapshot();
  });
  afterAll(async () => {
    await worker?.close();
    await app.close();
  });

  it('deactivation stamps deactivated_at (the clock the sweep reads)', async () => {
    const [r] = await dbQuery('SELECT deactivated_at, is_active FROM users WHERE id = $1', [recentLeaver.id]);
    expect(r.is_active).toBe(0);
    expect(r.deactivated_at).not.toBeNull();
  });

  it('is a no-op while RETENTION_ENABLED is off (the environment default)', async () => {
    const res = await retention.sweep();
    expect(res).toEqual(expect.objectContaining({ enabled: false, candidates: 0, anonymized: 0, purged: {} }));
    expect((await userRow(leaver.id)).first_name).toBe(leaver.firstName);
  });

  it('a dry run counts the person past the window and changes nothing', async () => {
    const before = await userRow(leaver.id);
    const res = await retention.sweep({ enabled: true, dryRun: true });
    expect(res.enabled).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.candidates).toBeGreaterThanOrEqual(1);
    expect(res.anonymized).toBe(0);
    expect(Object.keys(res.purged)).toEqual(expect.arrayContaining(['audit_log', 'notifications_read', 'certificate_files']));
    expect(await userRow(leaver.id)).toEqual(before);
    expect(before.anonymized_at).toBeNull();
    expect(await snapshot()).toEqual(fixtureSnapshot);
  });

  it('applying anonymises the leaver everywhere and leaves everyone else untouched', async () => {
    const fullName = `${leaver.firstName} Temp`;
    const res = await retention.sweep({ enabled: true, dryRun: false });
    expect(res.anonymized).toBeGreaterThanOrEqual(1);

    const u = await userRow(leaver.id);
    expect(`${u.first_name} ${u.last_name}`).toBe('Deleted User');
    expect(u.email).toBe(`deleted+${leaver.id}@retention.invalid`);
    expect(u.email).toMatch(/\.invalid$/);
    expect(u.phone).toBeNull();
    expect(u.is_active).toBe(0);
    expect(u.anonymized_at).not.toBeNull();
    expect(u.password).not.toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);

    // Cannot sign in, by the old address or the tombstone one.
    await anon(app).post('/api/auth/login').send({ email: leaver.email, password: leaver.password }).expect(401);
    await anon(app).post('/api/auth/login').send({ email: u.email, password: leaver.password }).expect(401);

    // The name is gone from a colleague's notification; their own post is removed.
    const named = await dbQuery("SELECT 1 FROM notifications WHERE user_id = $1 AND (actor_name = $2 OR body LIKE $3)", [fx.A.learner.id, fullName, `%${leaver.firstName}%`]);
    expect(named).toHaveLength(0);
    const own = await dbQuery("SELECT deleted_at FROM community_posts WHERE user_id = $1 AND type = 'question'", [leaver.id]);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((p) => p.deleted_at !== null)).toBe(true);

    // Everyone else: fixture people and the recent leaver are untouched.
    expect(await snapshot()).toEqual(fixtureSnapshot);
    const recent = await userRow(recentLeaver.id);
    expect(recent.first_name).toBe(recentLeaver.firstName);
    expect(recent.anonymized_at).toBeNull();
    await signIn(app, fx.A.learner2);
  });

  it('a second run is a no-op for the person already anonymised', async () => {
    const res = await retention.sweep({ enabled: true, dryRun: false });
    expect(res.anonymized).toBe(0);
    const dry = await retention.sweep({ enabled: true, dryRun: true });
    expect(dry.candidates).toBe(0);
  });
});
