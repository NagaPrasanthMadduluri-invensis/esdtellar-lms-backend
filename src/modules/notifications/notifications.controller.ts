import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { ListNotificationsDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * The bell, for every portal.
 *
 * Authenticated with NO `@Roles()`, deliberately: a learner, a trainer, an org
 * admin and a platform admin all have a bell, and gating it to one audience
 * would give three of the four a control that 403s. There is no `@Permissions()`
 * either — your own notifications are not a capability an organization grants.
 *
 * Nothing here takes a user id. Identity comes from the verified token and the
 * repository puts `user_id` in every predicate, so there is no parameter that
 * could read or clear somebody else's bell.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsDto,
  ) {
    return this.notifications.list(user.userId, query.limit, query.offset);
  }

  /**
   * Opening the bell marks everything read — which is what "seen" means here,
   * and what makes the badge disappear.
   */
  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notifications.markRead(user.userId, id);
  }
}
