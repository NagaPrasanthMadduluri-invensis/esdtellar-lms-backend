import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { CompetenciesService } from './competencies.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    listSkills: jest.fn().mockResolvedValue([]),
    findOwnedSkill: jest.fn().mockResolvedValue(null),
    slugExists: jest.fn().mockResolvedValue(false),
    createSkill: jest.fn().mockResolvedValue(42),
    updateSkill: jest.fn().mockResolvedValue(true),
    courseIsOwned: jest.fn().mockResolvedValue(true),
    courseIsVisible: jest.fn().mockResolvedValue(true),
    getCourseSkills: jest.fn().mockResolvedValue([]),
    setCourseSkills: jest.fn().mockResolvedValue(2),
    recordCourseSkills: jest.fn().mockResolvedValue(undefined),
    listUserCompetencies: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeCerts(complete: boolean) {
  return { isCourseComplete: jest.fn().mockResolvedValue(complete) } as any;
}

describe('CompetenciesService.onCourseCompleted', () => {
  it('records nothing when the course is not complete', async () => {
    const repo = makeRepo();
    const svc = new CompetenciesService(repo, makeCerts(false));

    await svc.onCourseCompleted(scope, 10, 100);

    expect(repo.recordCourseSkills).not.toHaveBeenCalled();
  });

  it('records the course skills when it IS complete', async () => {
    const repo = makeRepo();
    const svc = new CompetenciesService(repo, makeCerts(true));

    await svc.onCourseCompleted(scope, 10, 100);

    expect(repo.recordCourseSkills).toHaveBeenCalledWith(scope, 10, 100);
  });

  it('never throws into the caller (best-effort, §8.4)', async () => {
    const repo = makeRepo({
      recordCourseSkills: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const svc = new CompetenciesService(repo, makeCerts(true));

    await expect(svc.onCourseCompleted(scope, 10, 100)).resolves.toBeUndefined();
  });
});

describe('CompetenciesService skill curation', () => {
  it('rejects a duplicate slug with 409', async () => {
    const repo = makeRepo({ slugExists: jest.fn().mockResolvedValue(true) });
    const svc = new CompetenciesService(repo, makeCerts(true));

    await expect(svc.createSkill(scope, { name: 'Leadership' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.createSkill).not.toHaveBeenCalled();
  });

  it('rejects a name with no alphanumerics with 400', async () => {
    const repo = makeRepo();
    const svc = new CompetenciesService(repo, makeCerts(true));

    await expect(svc.createSkill(scope, { name: '!!!' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('normalises the slug on create', async () => {
    const repo = makeRepo();
    const svc = new CompetenciesService(repo, makeCerts(true));

    const skill = await svc.createSkill(scope, { name: '  Project  Management! ' });

    expect(repo.createSkill).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ slug: 'project-management' }),
    );
    expect(skill.slug).toBe('project-management');
  });

  it('404s when updating a skill this org does not own', async () => {
    const repo = makeRepo({ findOwnedSkill: jest.fn().mockResolvedValue(null) });
    const svc = new CompetenciesService(repo, makeCerts(true));

    await expect(svc.updateSkill(scope, 5, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when mapping skills onto a course this org does not own', async () => {
    const repo = makeRepo({ courseIsOwned: jest.fn().mockResolvedValue(false) });
    const svc = new CompetenciesService(repo, makeCerts(true));

    await expect(
      svc.setCourseSkills(scope, 100, { skills: [{ skillId: 1, level: 'advanced' }] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.setCourseSkills).not.toHaveBeenCalled();
  });
});

describe('CompetenciesService.getCourseSkills', () => {
  it('404s a course not visible to the org (another tenant or missing)', async () => {
    const repo = makeRepo({ courseIsVisible: jest.fn().mockResolvedValue(false) });
    const svc = new CompetenciesService(repo, makeCerts(false));

    await expect(svc.getCourseSkills(scope, 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.getCourseSkills).not.toHaveBeenCalled();
  });

  it('returns the tags of a visible course', async () => {
    const rows = [{ skill_id: 1, name: 'Excel', domain: null, level: 'beginner' }];
    const repo = makeRepo({ getCourseSkills: jest.fn().mockResolvedValue(rows) });
    const svc = new CompetenciesService(repo, makeCerts(false));

    await expect(svc.getCourseSkills(scope, 5)).resolves.toEqual(rows);
    expect(repo.courseIsVisible).toHaveBeenCalledWith(scope, 5);
  });
});

describe('CompetenciesService.setCourseSkills awards people who already completed', () => {
  it('records the skills for completers only, and reports how many', async () => {
    const repo = makeRepo({
      courseIsOwned: jest.fn().mockResolvedValue(true),
      setCourseSkills: jest.fn().mockResolvedValue(2),
      completionCandidates: jest.fn().mockResolvedValue([11, 12, 13]),
    });
    const certs = { isCourseComplete: jest.fn().mockImplementation(async (_s, uid) => uid !== 12) } as any;
    const svc = new CompetenciesService(repo, certs);

    const out = await svc.setCourseSkills(scope, 10, { skills: [{ skillId: 1, level: 'intermediate' }] } as any);

    expect(out).toEqual({ ok: true, count: 2, awarded: 2 });
    expect(repo.recordCourseSkills.mock.calls.map((c: any[]) => c[1])).toEqual([11, 13]);
  });

  it('clearing the tags awards nothing; one failure does not stop the rest', async () => {
    const repo = makeRepo({
      setCourseSkills: jest.fn().mockResolvedValue(0),
      completionCandidates: jest.fn().mockResolvedValue([11]),
    });
    const svc = new CompetenciesService(repo, makeCerts(true));
    expect(await svc.setCourseSkills(scope, 10, { skills: [] } as any)).toEqual({ ok: true, count: 0, awarded: 0 });
    expect(repo.completionCandidates).not.toHaveBeenCalled();

    const repo2 = makeRepo({
      completionCandidates: jest.fn().mockResolvedValue([1, 2]),
      recordCourseSkills: jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined),
    });
    expect(await new CompetenciesService(repo2, makeCerts(true)).awardToCompleters(scope, 10)).toBe(1);
  });
});

describe('CompetenciesService.skillsAnalytics', () => {
  it('shapes coverage, holders, trends and KPIs from the same rows', async () => {
    const repo = makeRepo({
      skillCoverage: jest.fn().mockResolvedValue([
        { skill_id: 1, name: 'Software Development', domain: 'Technical', people: 2, beginner: 0, intermediate: 2, advanced: 0, courses_tagged: 1 },
        { skill_id: 2, name: 'Sales', domain: 'Business', people: 0, beginner: 0, intermediate: 0, advanced: 0, courses_tagged: 1 },
      ]),
      skillHolders: jest.fn().mockResolvedValue([
        { skill_id: 1, user_id: 7, name: 'A B', department: 'Eng', job_role: 'Dev', level: 'intermediate', earned_at: 't' },
        { skill_id: 1, user_id: 8, name: 'C D', department: 'Eng', job_role: 'Dev', level: 'intermediate', earned_at: 't' },
      ]),
      skillTrend: jest.fn().mockResolvedValue([
        { month: '2026-10', earned: 0, learners: 0, holders: 0 },
        { month: '2026-11', earned: 2, learners: 2, holders: 2 },
      ]),
      skillTrendByDomain: jest.fn().mockResolvedValue([{ month: '2026-11', domain: 'Technical', earned: 2 }]),
      departmentCoverage: jest.fn().mockResolvedValue([{ department: 'Eng', headcount: 4, with_skills: 2, skills_held: 2 }]),
      untaggedCourses: jest.fn().mockResolvedValue([{ id: 3, public_id: 'u3', name: 'Etiquette', learners: 5 }]),
      activeLearnerCount: jest.fn().mockResolvedValue(10),
    });
    const out = await new CompetenciesService(repo, makeCerts(true)).skillsAnalytics(scope);

    expect(out.kpis).toEqual({ activeLearners: 10, peopleWithSkills: 2, coveragePct: 20, skillsHeld: 1, totalAwards: 2, avgPerPerson: 1, earnedThisMonth: 2 });
    expect(out.skills[0]).toMatchObject({ name: 'Software Development', people: 2, levels: { intermediate: 2 }, coursesTagged: 1 });
    expect(out.skills[0].holders).toHaveLength(2);
    expect(out.skills[1]).toMatchObject({ name: 'Sales', people: 0, holders: [] });
    expect(out.trendByDomain.series).toEqual([
      { month: '2026-10', Business: 0, Technical: 0 },
      { month: '2026-11', Business: 0, Technical: 2 },
    ]);
    expect(out.departments[0]).toMatchObject({ coveragePct: 50 });
    expect(out.untaggedCourses).toEqual([{ id: 'u3', name: 'Etiquette', learners: 5 }]);
  });
});
