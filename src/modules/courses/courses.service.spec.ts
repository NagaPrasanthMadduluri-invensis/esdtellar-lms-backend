import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CoursesService } from './courses.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as never;

function make(course: Record<string, unknown> | null) {
  const repository = {
    findById: jest.fn().mockResolvedValue(course),
    deleteCourse: jest.fn().mockResolvedValue(undefined),
    findLearner: jest.fn().mockResolvedValue({ id: 5 }),
    findAssignment: jest.fn().mockResolvedValue(null),
    createAssignment: jest.fn().mockResolvedValue(undefined),
    filterLearnersInOrg: jest.fn().mockResolvedValue([5]),
    createAssignments: jest.fn().mockResolvedValue(1),
  };
  const media = { discardCourseThumbnail: jest.fn().mockResolvedValue(undefined) };
  const service = new CoursesService(repository as never, media as never, {} as never, { record: jest.fn() } as never, { notify: jest.fn() } as never);
  return { service, repository, media };
}

const own = { id: 3, organizationId: 7, sessionId: null, archivedAt: null, thumbnailUrl: '/t.png' };

describe('CoursesService.remove', () => {
  it('404s an id outside the org and deletes nothing', async () => {
    const { service, repository } = make(null);
    await expect(service.remove(scope, 3)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.deleteCourse).not.toHaveBeenCalled();
  });

  it('refuses platform content and a session training with 422', async () => {
    for (const c of [{ ...own, organizationId: 1 }, { ...own, sessionId: 9 }]) {
      const { service, repository } = make(c);
      await expect(service.remove(scope, 3)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.deleteCourse).not.toHaveBeenCalled();
    }
  });

  it('deletes its own course and drops the picture', async () => {
    const { service, repository, media } = make(own);
    await expect(service.remove(scope, 3)).resolves.toEqual({ message: 'Course deleted' });
    expect(repository.deleteCourse).toHaveBeenCalledWith(scope, 3);
    expect(media.discardCourseThumbnail).toHaveBeenCalledWith('/t.png');
  });
});

describe('assigning an archived course', () => {
  const archived = { ...own, archivedAt: '2026-11-01T00:00:00Z' };

  it('single assign answers 422 and creates nothing', async () => {
    const { service, repository } = make(archived);
    await expect(service.assign(scope, 3, 1, { user_id: 5 } as never)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.createAssignment).not.toHaveBeenCalled();
  });

  it('bulk assign answers 422 and creates nothing', async () => {
    const { service, repository } = make(archived);
    await expect(service.createAssignments(scope, 3, { user_ids: [5] } as never, 1)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.createAssignments).not.toHaveBeenCalled();
  });

  it('a live course still assigns', async () => {
    const { service, repository } = make(own);
    await expect(service.assign(scope, 3, 1, { user_id: 5 } as never)).resolves.toEqual(expect.objectContaining({ created: true }));
    expect(repository.createAssignment).toHaveBeenCalled();
  });
});
