/**
 * Competencies (CONTEXT.md §5 Skill, Course skill tag; BACKEND §10.53): the
 * skills catalogue (platform starter + own), course skill tags, and Gained
 * skills recorded on course completion with level upgrade, never downgrade.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent } from './helpers';
import { assign, buildCourse, limitedAdmin } from './support/2';

type Skill = { id: number; name: string; slug: string; domain: string | null; is_active: number; is_shared: boolean; course_count: number; learner_count: number };

describe('competencies', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let noCourses: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    noCourses = (await limitedAdmin(app, adminA, fx.A, ['view_dashboard'])).agent;
  });
  afterAll(async () => { await app.close(); });

  it('lists the platform starter catalogue to every organization', async () => {
    const a = await adminA.get('/api/admin/skills').expect(200);
    const shared = a.body.skills.filter((s: Skill) => s.is_shared);
    expect(shared.length).toBeGreaterThan(0);
    const b = await adminB.get('/api/admin/skills').expect(200);
    expect(b.body.skills.filter((s: Skill) => s.is_shared).map((s: Skill) => s.id).sort()).toEqual(shared.map((s: Skill) => s.id).sort());
    await noCourses.get('/api/admin/skills').expect(403);
    await learnerA.get('/api/admin/skills').expect(403);
  });

  it('creates an own skill private to the org, refuses duplicates, renames and archives it', async () => {
    const name = uniq('Negotiation');
    const c = await adminA.post('/api/admin/skills').send({ name, domain: 'Soft' });
    expect(c.status).toBe(201);
    expect(c.body.skill).toEqual(expect.objectContaining({ name, domain: 'Soft', is_shared: false, course_count: 0, learner_count: 0 }));
    const id = c.body.skill.id;
    expect((await dbQuery('SELECT organization_id FROM skills WHERE id = $1', [id]))[0].organization_id).toBe(fx.A.id);

    await adminA.post('/api/admin/skills').send({ name: `  ${name.toUpperCase()} ` }).expect(409);
    await adminA.post('/api/admin/skills').send({ name: '!!!' }).expect(400);
    await adminA.post('/api/admin/skills').send({ name: '' }).expect(400);
    await noCourses.post('/api/admin/skills').send({ name: uniq('x') }).expect(403);
    // Another org may use the same name for its own skill.
    await adminB.post('/api/admin/skills').send({ name }).expect(201);

    const b = await adminB.get('/api/admin/skills').expect(200);
    expect(b.body.skills.some((s: Skill) => s.id === id)).toBe(false);
    await adminB.patch(`/api/admin/skills/${id}`).send({ name: 'hijack' }).expect(404);

    const ren = await adminA.patch(`/api/admin/skills/${id}`).send({ name: `${name} Pro` }).expect(200);
    expect(ren.body.skill).toEqual(expect.objectContaining({ id, name: `${name} Pro` }));
    await noCourses.patch(`/api/admin/skills/${id}`).send({ isActive: false }).expect(403);
    await adminA.patch(`/api/admin/skills/${id}`).send({ isActive: false }).expect(200);
    const live = await adminA.get('/api/admin/skills').expect(200);
    expect(live.body.skills.some((s: Skill) => s.id === id)).toBe(false);
    const all = await adminA.get('/api/admin/skills?archived=true').expect(200);
    expect(all.body.skills.find((s: Skill) => s.id === id)).toEqual(expect.objectContaining({ is_active: 0 }));

    // A platform skill is not this org's to edit.
    const shared = all.body.skills.find((s: Skill) => s.is_shared) as Skill;
    await adminA.patch(`/api/admin/skills/${shared.id}`).send({ name: 'mine now' }).expect(404);
  });

  it('tags a course with skills (own + platform), ignoring archived ones, and keeps other orgs out', async () => {
    const course = await buildCourse(adminA);
    const own = (await adminA.post('/api/admin/skills').send({ name: uniq('Excel'), domain: 'Technical' }).expect(201)).body.skill;
    const archived = (await adminA.post('/api/admin/skills').send({ name: uniq('Old') }).expect(201)).body.skill;
    await adminA.patch(`/api/admin/skills/${archived.id}`).send({ isActive: false }).expect(200);
    const shared = ((await adminA.get('/api/admin/skills').expect(200)).body.skills as Skill[]).find((s) => s.is_shared)!;

    const put = await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: own.id, level: 'beginner' }, { skillId: shared.id, level: 'advanced' }, { skillId: archived.id, level: 'beginner' }] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, count: 2, awarded: 0 });
    const get = await adminA.get(`/api/admin/skills/course/${course.id}`).expect(200);
    expect(get.body.skills.map((s: { skill_id: number; level: string }) => [s.skill_id, s.level]).sort()).toEqual([[own.id, 'beginner'], [shared.id, 'advanced']].sort());
    const list = await adminA.get('/api/admin/skills').expect(200);
    expect(list.body.skills.find((s: Skill) => s.id === own.id).course_count).toBe(1);

    await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: own.id, level: 'expert' }] }).expect(400);
    await adminB.put(`/api/admin/skills/course/${course.id}`).send({ skills: [] }).expect(404);
    await noCourses.put(`/api/admin/skills/course/${course.id}`).send({ skills: [] }).expect(403);
    await noCourses.get(`/api/admin/skills/course/${course.id}`).expect(403);
    // B's own skill cannot be put on A's course by A.
    const bSkill = (await adminB.post('/api/admin/skills').send({ name: uniq('Bskill') }).expect(201)).body.skill;
    const cross = await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: bSkill.id, level: 'beginner' }] }).expect(200);
    expect(cross.body.count).toBe(0);
  });

  it('another organization can read the skill tags of a course it does not own (should 404)', async () => {
    const course = await buildCourse(adminA);
    const shared = ((await adminA.get('/api/admin/skills').expect(200)).body.skills as Skill[]).find((s) => s.is_shared)!;
    await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: shared.id, level: 'advanced' }] }).expect(200);
    await adminB.get(`/api/admin/skills/course/${course.id}`).expect(404);
  });

  it('records gained skills on course completion, upgrading the level and never downgrading it', async () => {
    const skill = (await adminA.post('/api/admin/skills').send({ name: uniq('Python'), domain: 'Technical' }).expect(201)).body.skill;
    const intro = await buildCourse(adminA, { lessons: 2 });
    const adv = await buildCourse(adminA);
    const refresher = await buildCourse(adminA);
    await adminA.put(`/api/admin/skills/course/${intro.id}`).send({ skills: [{ skillId: skill.id, level: 'intermediate' }] }).expect(200);
    await adminA.put(`/api/admin/skills/course/${adv.id}`).send({ skills: [{ skillId: skill.id, level: 'advanced' }] }).expect(200);
    await adminA.put(`/api/admin/skills/course/${refresher.id}`).send({ skills: [{ skillId: skill.id, level: 'beginner' }] }).expect(200);

    const p = await newPerson(adminA, fx.A);
    const me = await signIn(app, p);
    await assign(adminA, intro.id, [p.id]);
    await assign(adminA, adv.id, [p.id]);
    await assign(adminA, refresher.id, [p.id]);

    const empty = await me.get('/api/learner/competencies').expect(200);
    expect(empty.body.competencies).toEqual([]);

    // Half a course gains nothing.
    await me.post(`/api/learner/lessons/${intro.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await me.get('/api/learner/competencies').expect(200)).body.competencies).toEqual([]);

    await me.post(`/api/learner/lessons/${intro.lessonIds[1]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
    let mine = (await me.get('/api/learner/competencies').expect(200)).body.competencies;
    expect(mine).toEqual([expect.objectContaining({ skill_id: skill.id, skill: skill.name, level: 'intermediate', source_course: intro.name })]);

    await me.post(`/api/learner/lessons/${adv.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
    mine = (await me.get('/api/learner/competencies').expect(200)).body.competencies;
    expect(mine[0]).toEqual(expect.objectContaining({ level: 'advanced', source_course: adv.name }));

    await me.post(`/api/learner/lessons/${refresher.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
    mine = (await me.get('/api/learner/competencies').expect(200)).body.competencies;
    expect(mine).toHaveLength(1);
    expect(mine[0].level).toBe('advanced');

    const [row] = await dbQuery('SELECT organization_id FROM user_skills WHERE user_id = $1 AND skill_id = $2', [p.id, skill.id]);
    expect(row.organization_id).toBe(fx.A.id);
    const list = await adminA.get('/api/admin/skills').expect(200);
    expect(list.body.skills.find((s: Skill) => s.id === skill.id).learner_count).toBe(1);

    // Only the caller's own competencies, and only for the learner portal.
    expect((await learnerA.get('/api/learner/competencies').expect(200)).body.competencies.some((c: { skill_id: number }) => c.skill_id === skill.id)).toBe(false);
    await adminA.get('/api/learner/competencies').expect(403);
  });

  it('tagging a course AFTER someone completed it gives them the skills; the course page marks them earned', async () => {
    const skill = (await adminA.post('/api/admin/skills').send({ name: uniq('SecureCoding'), domain: 'Technical' }).expect(201)).body.skill;
    const course = await buildCourse(adminA);
    const done = await newPerson(adminA, fx.A);
    const halfway = await newPerson(adminA, fx.A);
    await assign(adminA, course.id, [done.id, halfway.id]);
    const me = await signIn(app, done);
    await me.post(`/api/learner/lessons/${course.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await me.get('/api/learner/competencies').expect(200)).body.competencies).toEqual([]);

    // The admin tags the course now: the completer is awarded, nobody else.
    const put = await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: skill.id, level: 'intermediate' }] }).expect(200);
    expect(put.body).toEqual({ ok: true, count: 1, awarded: 1 });
    const mine = (await me.get('/api/learner/competencies').expect(200)).body.competencies;
    expect(mine).toEqual([expect.objectContaining({ skill_id: skill.id, level: 'intermediate', source_course: course.name })]);
    expect(await dbQuery('SELECT 1 FROM user_skills WHERE user_id = $1', [halfway.id])).toEqual([]);

    // The learner's course page carries the real skill tags, marked earned.
    const detail = await me.get(`/api/learner/courses/${course.id}`).expect(200);
    expect(detail.body.skills).toEqual([expect.objectContaining({ skillId: skill.id, name: skill.name, level: 'intermediate', earned: true })]);
    const other = await signIn(app, halfway);
    expect((await other.get(`/api/learner/courses/${course.id}`).expect(200)).body.skills[0].earned).toBe(false);
  });

  it('admin skills analytics: who holds what, trends and coverage; needs view_reports; never another org', async () => {
    const skill = (await adminA.post('/api/admin/skills').send({ name: uniq('Analytics'), domain: 'Technical' }).expect(201)).body.skill;
    const course = await buildCourse(adminA);
    await adminA.put(`/api/admin/skills/course/${course.id}`).send({ skills: [{ skillId: skill.id, level: 'advanced' }] }).expect(200);
    const p = await newPerson(adminA, fx.A);
    await assign(adminA, course.id, [p.id]);
    const me = await signIn(app, p);
    await me.post(`/api/learner/lessons/${course.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));

    const a = await adminA.get('/api/admin/skills/analytics').expect(200);
    const row = a.body.skills.find((s: { skillId: number }) => s.skillId === skill.id);
    expect(row).toMatchObject({ name: skill.name, domain: 'Technical', people: 1, levels: { advanced: 1 }, coursesTagged: 1 });
    expect(row.holders).toEqual([expect.objectContaining({ userId: p.id, level: 'advanced' })]);
    expect(a.body.trend).toHaveLength(12);
    expect(a.body.trend.at(-1).earned).toBeGreaterThanOrEqual(1);
    expect(a.body.kpis.peopleWithSkills).toBeGreaterThanOrEqual(1);
    expect(a.body.trendByDomain.domains).toContain('Technical');
    expect(Array.isArray(a.body.departments)).toBe(true);
    expect(Array.isArray(a.body.untaggedCourses)).toBe(true);

    // Org B sees none of org A's holders, even on a shared platform skill.
    const b = await adminB.get('/api/admin/skills/analytics').expect(200);
    expect(b.body.skills.some((s: { skillId: number }) => s.skillId === skill.id)).toBe(false);
    expect(JSON.stringify(b.body)).not.toContain(p.email);
    for (const s of b.body.skills) for (const h of s.holders) expect(h.userId).not.toBe(p.id);

    await noCourses.get('/api/admin/skills/analytics').expect(403);
    await learnerA.get('/api/admin/skills/analytics').expect(403);
  });
});
