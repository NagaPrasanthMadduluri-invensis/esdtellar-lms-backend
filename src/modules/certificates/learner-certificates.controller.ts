import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

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
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { certificates: await this.certificates.listForLearner(user.userId) };
  }

  /** 403 when the certificate belongs to another learner, 404 when missing. */
  @Get(':id')
  async detail(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return {
      certificate: await this.certificates.getForLearner(id, user.userId),
    };
  }
}
