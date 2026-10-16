import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

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

  @Get(':userId')
  thread(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.messages.thread(scope, user, userId);
  }

  @Post(':userId')
  send(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(scope, user, userId, dto.body);
  }
}
