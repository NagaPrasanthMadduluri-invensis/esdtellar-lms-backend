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
