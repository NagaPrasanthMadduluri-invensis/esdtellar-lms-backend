import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as never;

function make(deletable: Set<number>) {
  const repository = {
    findTrainingThumbnail: jest.fn().mockResolvedValue(null),
    deleteSession: jest.fn((_s: unknown, id: number) => Promise.resolve(deletable.has(id))),
  };
  const media = { discardCourseThumbnail: jest.fn().mockResolvedValue(undefined) };
  const service = new SessionsService(repository as never, media as never, { record: jest.fn() } as never, { notify: jest.fn() } as never);
  return { service, repository };
}

describe('SessionsService delete', () => {
  it('404s a session that is not this org\'s (nothing was deleted)', async () => {
    const { service } = make(new Set());
    await expect(service.remove(scope, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes its own session', async () => {
    const { service } = make(new Set([42]));
    await expect(service.remove(scope, 42)).resolves.toEqual({ message: 'Session deleted' });
  });

  it('bulk delete counts only sessions actually deleted', async () => {
    const { service } = make(new Set([1]));
    await expect(service.bulk(scope, [1, 2, 99999999], 'delete')).resolves.toEqual({ affected: 1, requested: 3, action: 'delete' });
  });
});
