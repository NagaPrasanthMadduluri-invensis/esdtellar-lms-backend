import { Controller, Get, Query } from '@nestjs/common';

import {
  CurrentScope,
  CurrentUser,
  Permissions,
  Roles,
} from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import { ListFeedbackQueryDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * The trainer's Feedback page — anonymised.
 *
 * Read-only by design. A trainer cannot delete a response or reply to one:
 * feedback they can remove is feedback nobody should trust, and a reply
 * channel would need the author's identity, which is precisely what this
 * feature withholds. Abuse is an admin's to handle, with the names.
 *
 * `view_own_sessions` rather than a new permission. This returns nothing but
 * facts about sessions that permission already grants sight of, and §5.2.1's
 * invariant cuts both ways — a permission with no guard is a screen that
 * lies, and a guard with no distinct meaning is a permission nobody can
 * reason about.
 *
 * The trainer axis is a SQL predicate (`FeedbackRepository.trainerOwns`), not
 * a filter this controller passes, so there is no "all feedback" state to get
 * wrong and no id a trainer could substitute to read a colleague's reviews.
 */
@Controller('trainer/feedback')
@Roles('trainer')
@Permissions('view_own_sessions')
export class TrainerFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  async overview(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListFeedbackQueryDto,
  ) {
    return this.feedback.overviewForTrainer(scope, user.userId, query);
  }
}
