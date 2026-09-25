import { Controller, Get } from '@nestjs/common';

import { CurrentScope, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import { OrgOptionsService } from './org-options.service';

/**
 * What THIS organization's forms may offer. Read-only, by design.
 *
 * The tenant cannot write its own lists — that is the property carried over
 * from the code catalogue these tables replaced (§10.3.1.1): the values are
 * only worth anything as reporting dimensions because somebody curates them,
 * and an org that could add a branch on the fly would recreate the free-text
 * `job_role` problem with extra steps.
 *
 * No `@Permissions()`: anybody who can open a user form needs the options in
 * it, and the two permissions that reach those forms (`manage_users`,
 * `edit_employees`) are what actually gate the writes.
 *
 * Its org comes from `@CurrentScope()`, so unlike the platform controller
 * beside it there is no path parameter to point somewhere else.
 */
@Controller('admin/organization/options')
@Roles('admin')
export class AdminOrgOptionsController {
  constructor(private readonly options: OrgOptionsService) {}

  @Get()
  async get(@CurrentScope() scope: OrgScope) {
    return this.options.forScope(scope);
  }
}
