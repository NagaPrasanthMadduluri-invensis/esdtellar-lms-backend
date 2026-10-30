import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import { SendMessageDto } from './dto/message.dto';
import { MessagesService } from './messages.service';

/**
 * Direct messages, learner-portal audience (a Manager rides the learner portal,
 * so they are covered too). No `@Permissions()`: messaging a colleague is not a
 * capability an org grants, like the bell and your own settings. The other
 * person is named by their integer user id, matching `/team/:userId/nudge`
 * (users are not in the public_id whitelist, §10.34). Entitlement — same org,
 * active, not yourself — is enforced in the service, not the route.
 */
@Controller('learner/messages')
@Roles('learner')
export class LearnerMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  conversations(@CurrentScope() scope: OrgScope, @CurrentUser() user: AuthenticatedUser) {
    return this.messages.conversations(scope, user.userId);
  }

  // Before ':userId', or "unread" would be parsed as a user id.
  @Get('unread')
  unread(@CurrentScope() scope: OrgScope, @CurrentUser() user: AuthenticatedUser) {
    return this.messages.unread(scope, user.userId);
  }

  /** Download/open a message's attachment — sender or recipient only (checked
   *  in the service). Declared before ':userId'. */
  @Get('attachments/:messageId/file')
  @HttpCode(200)
  async attachment(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Res() res: Response,
  ) {
    const { stream, fileName, mime } = await this.messages.messageFile(scope, user, messageId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    stream.pipe(res);
  }

  @Get(':userId')
  thread(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.messages.thread(scope, user, userId);
  }

  @Post(':userId')
  @UseInterceptors(FileInterceptor('file'))
  send(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SendMessageDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.messages.send(scope, user, userId, dto.body ?? '', file);
  }
}
