import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, ROLES_KEY } from '../decorators';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';

/**
 * Extra permissions cross portals (BACKEND_STRUCTURE §10.65): RolesGuard lets
 * a learner/trainer caller onto an `@Roles('admin')` route only when the route
 * names a permission, and PermissionsGuard then decides.
 */
function ctx(meta: Record<string, unknown>, user: unknown) {
  const handler = () => undefined;
  Reflect.defineMetadata('meta', meta, handler);
  const reflector = {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
  return { reflector, context: context as never };
}

const run = (meta: Record<string, unknown>, user: unknown) => {
  const { reflector, context } = ctx(meta, user);
  return new RolesGuard(reflector).canActivate(context) && new PermissionsGuard(reflector).canActivate(context);
};

const admin = (permissions: string[] = []) => ({ role: 'admin', permissions });
const learner = (permissions: string[] = []) => ({ role: 'learner', permissions });

describe('RolesGuard + PermissionsGuard: cross-portal extras', () => {
  it('an admin route with no permission stays the admin portal\'s', () => {
    const meta = { [ROLES_KEY]: ['admin'] };
    expect(run(meta, admin())).toBe(true);
    expect(() => run(meta, learner(['manage_courses']))).toThrow(ForbiddenException);
  });

  it('@Permissions opens an admin route to a learner who holds it, and only then', () => {
    const meta = { [ROLES_KEY]: ['admin'], [PERMISSIONS_KEY]: ['manage_courses'] };
    expect(run(meta, learner(['manage_courses']))).toBe(true);
    expect(() => run(meta, learner(['view_reports']))).toThrow(ForbiddenException);
    expect(() => run(meta, learner())).toThrow(ForbiddenException);
    expect(() => run(meta, admin(['view_reports']))).toThrow(ForbiddenException);
    expect(run(meta, admin(['manage_courses']))).toBe(true);
  });

  it('@CrossPortal binds only callers from another portal', () => {
    const meta = { [ROLES_KEY]: ['admin'], [ANY_PERMISSIONS_KEY]: ['manage_courses', 'assign_learning'] };
    expect(run(meta, admin())).toBe(true); // content reads stay open to admin roles
    expect(run(meta, learner(['assign_learning']))).toBe(true);
    expect(() => run(meta, learner(['view_reports']))).toThrow(/one of/);
  });

  it('learner routes never open to an admin, whatever it holds', () => {
    const meta = { [ROLES_KEY]: ['learner'], [PERMISSIONS_KEY]: ['view_team_learning'] };
    expect(() => run(meta, admin(['view_team_learning']))).toThrow(ForbiddenException);
    expect(run(meta, learner(['view_team_learning']))).toBe(true);
  });
});
