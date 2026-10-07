import { Controller, Get, Query } from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { AuditService, type AuditQuery } from './audit.service';

/**
 * Every tenant's activity, including the tenant admins' own actions.
 *
 * A SECOND controller over the same service rather than the tenant one
 * widened — §10.17's rule, and here it is load-bearing rather than tidy: the
 * tenant controller hands `scope.organizationId` to the service and this one
 * hands `null`, so cross-tenant reach is a property of which class answered
 * the request, not of a parameter a caller could supply.
 *
 * `organization_id` on the query narrows to one tenant. It is accepted ONLY
 * here: `AuditService.list` ignores it entirely unless the caller already
 * passed null for the scope, so the same query string against the admin
 * route changes nothing.
 */
@Controller('platform/activity')
@PlatformAdmin()
export class PlatformAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Query() query: AuditQuery) {
    return this.audit.list(null, query);
  }

  @Get('options')
  async options() {
    return this.audit.options(null);
  }
}
