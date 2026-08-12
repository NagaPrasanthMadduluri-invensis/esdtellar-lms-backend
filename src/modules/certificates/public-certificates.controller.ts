import { Controller, Get, Param } from '@nestjs/common';

import { Public } from '@/common/decorators';

import { CertificatesService } from './certificates.service';

/**
 * Unauthenticated by design so a third party can validate a certificate code.
 *
 * PII rule: this response must never carry a learner name, email, employee id
 * or department. The repository query behind it selects no user column at all,
 * so the constraint is enforced by the query shape rather than by remembering
 * to strip fields here.
 */
@Controller('certificates')
export class PublicCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Public()
  @Get('verify/:code')
  async verify(@Param('code') code: string) {
    return this.certificates.verify(code);
  }
}
