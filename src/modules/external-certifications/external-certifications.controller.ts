import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import {
  CurrentScope,
  CurrentUser,
  Permissions,
  Roles,
} from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import {
  DecideExternalCertificationDto,
  ListExternalCertificationsQueryDto,
  SubmitExternalCertificationDto,
} from './dto/external-certification.dto';
import { ExternalCertificationsService } from './external-certifications.service';

/**
 * The learner's own claims.
 *
 * `@Roles('learner')` and no `@Permissions()`: telling your employer about
 * training you did elsewhere is not a capability an organization grants to
 * some of its learners and withholds from others. A Manager rides in the
 * learner portal and reaches this too, which is right — they take courses
 * like anybody else.
 *
 * NO ROUTE TAKES A USER ID. Who is claiming comes from the verified token,
 * so nobody can file a certification in a colleague's name.
 */
@Controller('learner/external-certifications')
@Roles('learner')
export class LearnerExternalCertificationsController {
  constructor(private readonly certs: ExternalCertificationsService) {}

  @Get()
  async mine(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.certs.listForLearner(scope, user.userId);
  }

  /**
   * Submit a claim. Multipart: the five fields and the file arrive together
   * in ONE request rather than through a presign, because the file is a
   * scanned certificate rather than a video — and because a presign would
   * let a learner upload bytes that no row ever claims, which is debris
   * §10.9 had to write a sweeper for.
   */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async submit(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitExternalCertificationDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.certs.submit(scope, user, dto, file);
  }
}

/**
 * The manager's queue, on the learner portal where a manager already lives
 * (rbac.md decision 2).
 *
 * `view_team_learning` — the same permission that lets somebody see their
 * reports' progress at all. Confirming that a report completed a course is
 * the same grant of visibility seen from the other side, and a separate
 * permission would be one nobody thinks to give out.
 */
@Controller('learner/team/external-certifications')
@Roles('learner')
@Permissions('view_team_learning')
export class ManagerExternalCertificationsController {
  constructor(private readonly certs: ExternalCertificationsService) {}

  /** What is waiting on me. Empty is a real answer, not an error. */
  @Get()
  async queue(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.certs.listForManager(scope, user.userId);
  }

  /** Confirm they completed it, or refuse with a reason. */
  @Patch(':id')
  async decide(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideExternalCertificationDto,
  ) {
    return this.certs.decideAsManager(scope, user, id, dto);
  }
}

/**
 * L&D's queue and the final decision.
 *
 * `manage_certificates` — "Issue and revoke certificates". Approving an
 * external one puts a completed course and its hours on somebody's record,
 * which is the same weight of action, so it reuses that permission rather
 * than adding one. A new entry would need its own grant migration, and
 * every one of those signs every user in every organization out once
 * (§10.17).
 */
@Controller('admin/external-certifications')
@Roles('admin')
@Permissions('manage_certificates')
export class AdminExternalCertificationsController {
  constructor(private readonly certs: ExternalCertificationsService) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListExternalCertificationsQueryDto,
  ) {
    return this.certs.listForAdmin(scope, {
      status: query.status,
      limit: Math.min(query.limit ?? 50, 100),
      offset: query.offset ?? 0,
    });
  }

  @Patch(':id')
  async decide(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideExternalCertificationDto,
  ) {
    return this.certs.decideAsAdmin(scope, user, id, dto);
  }
}

/**
 * The uploaded document — ONE route for all three audiences.
 *
 * Deliberately no `@Roles()`: the three people entitled to read a
 * certificate are not three roles but a relationship to the row — its
 * owner, the manager it was sent to, and an admin of that learner's
 * organization. `ExternalCertificationsService.fileFor` is where that is
 * decided, which is §5.3's rule (ownership in the service, not the guard),
 * and it keeps one definition rather than three copies that drift.
 *
 * It streams from disk rather than redirecting: the file lives OUTSIDE the
 * directory `useStaticAssets` publishes, precisely so there is no URL that
 * serves it without passing through this check.
 */
@Controller('external-certifications')
export class ExternalCertificationFileController {
  constructor(private readonly certs: ExternalCertificationsService) {}

  @Get(':id/file')
  @HttpCode(200)
  async file(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const { stream, fileName, mime } = await this.certs.fileFor(
      scope,
      user,
      id,
    );
    res.setHeader('Content-Type', mime);
    // `inline` so a PDF opens in the viewer rather than landing in Downloads
    // — an approver is looking at it, not filing it.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${fileName.replace(/"/g, '')}"`,
    );
    // The browser must be able to read the name (§10.12): CORS exposes only
    // a handful of headers by default and the API is a different origin.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    stream.pipe(res);
  }
}
