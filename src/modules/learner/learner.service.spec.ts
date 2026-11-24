import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { assertLessonUnlocked, LearnerService } from './learner.service';

const row = (id: number, module_id: number, done = false) => ({ id, module_id, progress_status: done ? 'completed' : 'not_started' });

describe('assertLessonUnlocked', () => {
  it('opens the first lesson of the first module', () => {
    expect(() => assertLessonUnlocked([row(1, 10), row(2, 10)], 1, 10)).not.toThrow();
  });

  it('locks a lesson until the previous one in its module is complete', () => {
    expect(() => assertLessonUnlocked([row(1, 10), row(2, 10)], 2, 10)).toThrow(ForbiddenException);
    expect(() => assertLessonUnlocked([row(1, 10, true), row(2, 10)], 2, 10)).not.toThrow();
  });

  it('locks a module\'s first lesson until the previous module is complete', () => {
    const all = [row(1, 10, true), row(2, 10), row(3, 20)];
    expect(() => assertLessonUnlocked(all, 3, 20)).toThrow(/previous module/);
    expect(() => assertLessonUnlocked([row(1, 10, true), row(2, 10, true), row(3, 20)], 3, 20)).not.toThrow();
  });

  it('leaves a lesson outside the live list to the caller', () => {
    expect(() => assertLessonUnlocked([row(1, 10)], 99, 10)).not.toThrow();
  });
});


describe('LearnerService course preview (§10.64)', () => {
  const scope = { organizationId: 7, platformOrganizationId: 1 } as any;
  const lessons = [
    { id: 1, public_id: 'u1', module_id: 10, title: 'One', content_type: 'text', progress_status: 'not_started' },
    { id: 2, public_id: 'u2', module_id: 10, title: 'Two', content_type: 'video', progress_status: 'not_started' },
    { id: 3, public_id: 'u3', module_id: 20, title: 'Three', content_type: 'text', progress_status: 'not_started' },
  ];
  function make(over: Record<string, any> = {}) {
    const repo = {
      findCourseForPreview: jest.fn().mockResolvedValue({ id: 5, name: 'Draft course', is_active: 0 }),
      activeModules: jest.fn().mockResolvedValue([{ id: 10 }, { id: 20 }]),
      lessonsWithStatus: jest.fn().mockResolvedValue(lessons),
      courseAssessments: jest.fn().mockResolvedValue([{ id: 8, attempt_count: 2, best_score: 90 }]),
      findLessonWithModule: jest.fn().mockResolvedValue({ id: 3, public_id: 'u3', module_id: 20, course_id: 5, title: 'Three', content_type: 'text', module_title: 'M2' }),
      lessonResources: jest.fn().mockResolvedValue([]),
      findAssignment: jest.fn(),
      isAssigned: jest.fn(),
      ...over,
    } as any;
    const competencies = { courseSkillsFor: jest.fn().mockResolvedValue([{ skillId: 1, name: 'APIs', earned: true, heldLevel: 2 }]) } as any;
    const journeys = { assertCourseUnlocked: jest.fn() } as any;
    const noop = {} as any;
    const svc = new LearnerService(repo, noop, noop, noop, noop, journeys, noop, noop, competencies);
    return { svc, repo, journeys };
  }

  it('opens a draft course with every lesson unlocked, nothing complete and no enrolment', async () => {
    const { svc, repo } = make();
    const r = await svc.previewCourse(scope, 99, 5);
    expect(repo.findAssignment).not.toHaveBeenCalled();
    expect(r.preview).toBe(true);
    expect(r.enrollment).toBeNull();
    expect(r.assessmentsUnlocked).toBe(true);
    expect(r.course).toEqual(expect.objectContaining({ is_active: 0, modules_count: 2, lessons_count: 3 }));
    expect(r.modules.flatMap((m: any) => m.lessons.map((l: any) => l.is_locked))).toEqual([false, false, false]);
    expect(r.assessments[0]).toEqual(expect.objectContaining({ attempt_count: 0, best_score: null, last_attempt: null }));
    expect(r.skills[0]).toEqual(expect.objectContaining({ earned: false, heldLevel: null }));
  });

  it('a lesson deep in the course opens in preview with no gate, all available', async () => {
    const { svc, repo, journeys } = make();
    const r = await svc.previewLesson(scope, 99, 3);
    expect(repo.isAssigned).not.toHaveBeenCalled();
    expect(journeys.assertCourseUnlocked).not.toHaveBeenCalled();
    expect(r.preview).toBe(true);
    expect(r.playlist.map((l: any) => l.status)).toEqual(['available', 'available', 'current']);
    expect(r.prev_lesson).toEqual({ id: 'u2', title: 'Two' });
    expect(r.position).toBe(3);
  });

  it('404s a course or lesson outside the admin\'s scope', async () => {
    const { svc } = make({ findCourseForPreview: jest.fn().mockResolvedValue(null), findLessonWithModule: jest.fn().mockResolvedValue(null) });
    await expect(svc.previewCourse(scope, 99, 5)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.previewLesson(scope, 99, 3)).rejects.toBeInstanceOf(NotFoundException);
  });
});
