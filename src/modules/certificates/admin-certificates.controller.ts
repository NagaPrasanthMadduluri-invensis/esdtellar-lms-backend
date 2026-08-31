import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { CertificatesService } from './certificates.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import { ListCertificatesQueryDto } from './dto/list-certificates-query.dto';

@Controller('admin/certificates')
@Roles('admin')
export class AdminCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  async list(
    @Query() query: ListCertificatesQueryDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return {
      certificates: await this.certificates.listForAdmin(scope, {
        userId: query.userId,
        courseId: query.courseId,
      }),
    };
  }

  /**
   * Manual issue. Auto-issue still runs on completion — this is the override
   * for what it cannot see, and it records who granted it.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async issue(
    @Body() dto: IssueCertificateDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return {
      ok: true,
      certificate: await this.certificates.issueManually(
        scope,
        dto.userId,
        dto.courseId,
        admin.userId,
      ),
    };
  }

  /** Soft revoke — sets is_revoked/revoked_at/revoked_by. Never deletes a row. */
  @Delete(':id')
  async revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    await this.certificates.revoke(scope, id, admin.userId);
    return { ok: true };
  }

  /** Reinstate a revoked certificate. 409 when it is not currently revoked. */
  @Patch(':id')
  async reinstate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return {
      ok: true,
      certificate: await this.certificates.reinstate(scope, id),
    };
  }
}
