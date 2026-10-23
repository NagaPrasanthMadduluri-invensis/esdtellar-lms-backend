import { Controller, Get, Param } from '@nestjs/common';

import { Public } from '@/common/decorators';

import { CertificatesService } from './certificates.service';

/**
 * Unauthenticated by design so a third party can validate a certificate code
 * by scanning the QR printed on the document (or opening /verify/:code).
 *
 * It DOES return the holder's name and issuing organisation (owner's decision,
 * 2026-10-23) — a scan-to-verify page shows what the certificate shows, since
 * whoever scans it is already holding that document. It still returns no email,
 * employee id or department. Because PII is now reachable by code, this
 * endpoint should be rate-limited (a tracked follow-up): short codes plus a
 * named holder make enumeration worth guarding against.
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
