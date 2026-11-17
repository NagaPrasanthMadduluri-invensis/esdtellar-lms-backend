import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RateLimit } from '@/common/rate-limit/rate-limit';
import type { Request, Response } from 'express';

import { requestMeta } from '@/modules/consent/consent-log.service';

import { CurrentUser } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { MyDataService } from './my-data.service';
import {
  CreateDataRequestDto,
  ListMyDataRequestsDto,
} from './dto/data-request.dto';

/**
 * "My Data" — the data subject's own half (0056).
 *
 * No `@Roles()`: every authenticated person is a data subject entitled to a
 * copy of their own data, so this serves learners, trainers and admins alike
 * (the same reasoning as change-password and the email-preference routes). The
 * subject is ALWAYS the caller — `userId` and `organizationId` come from the
 * verified token, never a parameter — so no route here can read or request
 * anyone else's data.
 */
@Controller('my-data')
export class MyDataController {
  constructor(private readonly myData: MyDataService) {}

  /** The readable summary: who the record is about, and counts per category. */
  @Get()
  async summary(@CurrentUser() user: AuthenticatedUser) {
    return this.myData.summary(user.userId);
  }

  /**
   * The full machine-readable export as a JSON download.
   *
   * Streams with the same download headers the reports exporter uses, including
   * `Access-Control-Expose-Headers: Content-Disposition` so the cross-origin
   * fetch in `client/lib/download.js` can read the filename.
   */
  // The export reads ~25 tables; nobody needs it more than a few times an hour.
  @RateLimit({ name: 'my-data-export', by: 'user', limit: 10, windowSeconds: 3600,
    message: 'You have downloaded your data several times recently.' })
  @Get('export')
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const data = await this.myData.exportAll(user.userId);
    const filename = this.myData.exportFilename(
      data.account as { email?: unknown },
      user.userId,
    );
    const body = JSON.stringify(data, null, 2);
    response
      .status(200)
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .send(body);
  }

  /**
   * The caller's privacy record: the notice version they acknowledged, and
   * their consent log (0065).
   */
  @Get('consent')
  async consent(@CurrentUser() user: AuthenticatedUser) {
    return this.myData.consentRecord(user.userId);
  }

  /** The caller's own correction/deletion requests and their status. */
  @Get('requests')
  async myRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMyDataRequestsDto,
  ) {
    return this.myData.listMyRequests(
      user.userId,
      query.limit ?? 50,
      query.offset ?? 0,
    );
  }

  /** File a correction or deletion request about the caller's own data. */
  @Post('requests')
  @HttpCode(201)
  async createRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDataRequestDto,
    @Req() request: Request,
  ) {
    return this.myData.createRequest(
      user.userId,
      user.organizationId,
      user,
      dto,
      requestMeta(request),
    );
  }
}
