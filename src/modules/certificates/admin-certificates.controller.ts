import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { CertificatesService } from './certificates.service';
import { ListCertificatesQueryDto } from './dto/list-certificates-query.dto';

@Controller('admin/certificates')
@Roles('admin')
export class AdminCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  async list(@Query() query: ListCertificatesQueryDto) {
    return {
      certificates: await this.certificates.listForAdmin({
        userId: query.userId,
        courseId: query.courseId,
      }),
    };
  }

  /** Soft revoke — sets is_revoked/revoked_at/revoked_by. Never deletes a row. */
  @Delete(':id')
  async revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    await this.certificates.revoke(id, admin.userId);
    return { ok: true };
  }

  /** Reinstate a revoked certificate. 409 when it is not currently revoked. */
  @Patch(':id')
  async reinstate(@Param('id', ParseIntPipe) id: number) {
    return { ok: true, certificate: await this.certificates.reinstate(id) };
  }
}
