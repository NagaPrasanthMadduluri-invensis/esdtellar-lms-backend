import { ForbiddenException } from '@nestjs/common';
import { assertLessonUnlocked } from './learner.service';

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
