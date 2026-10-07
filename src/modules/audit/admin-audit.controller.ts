import { Controller, Get, Query } from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import { AuditService, type AuditQuery } from './audit.service';

/**
 * The organization's own activity log.
 *
 * **The scope comes from `@CurrentScope()` and there is no org parameter**,
 * so unlike the platform controller beside it there is nothing an admin
 * could point at another tenant. That is the §10.17 shape: a second
 * controller per audience, never one widened with an `if`.
 *
 * **`view_reports` rather than a new `view_activity`.** §10.24 states the
 * rule this follows: a dedicated permission needs its own grant migration,
 * and every one of those bumps `perm_version` and signs every user in every
 * organization out once. Nobody has yet asked for an admin who may read
 * reports but not the activity log, and `view_reports` is already the
 * permission over "the evidence". When an organization wants that
 * separation, that is the moment to add the entry and pay for the migration
 * — not before.
 */
@Controller('admin/activity')
@Roles('admin')
@Permissions('view_reports')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@CurrentScope() scope: OrgScope, @Query() query: AuditQuery) {
    return this.audit.list(scope.organizationId, query);
  }

  @Get('options')
  async options(@CurrentScope() scope: OrgScope) {
    return this.audit.options(scope.organizationId);
  }
}
