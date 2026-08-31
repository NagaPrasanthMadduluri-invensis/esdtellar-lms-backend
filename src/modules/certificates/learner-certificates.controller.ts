import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { CertificatesService } from './certificates.service';

/**
 * There is no learner issue endpoint by design — initial issuance happens
 * automatically at course completion, and re-issuing a revoked certificate is
 * admin-only. See specs/certificates.md §7a.
 */
@Controller('learner/certificates')
@Roles('learner')
export class LearnerCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return {
      certificates: await this.certificates.listForLearner(scope, user.userId),
    };
  }

  /** 403 when the certificate belongs to another learner, 404 when missing. */
  @Get(':id')
  async detail(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return {
      certificate: await this.certificates.getForLearner(
        scope,
        id,
        user.userId,
      ),
    };
  }
}
