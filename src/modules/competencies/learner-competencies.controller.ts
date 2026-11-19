import { Controller, Get } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { CompetenciesService } from './competencies.service';

/**
 * A learner's own gained competencies (spec ai-insights.md Wave 0).
 *
 * No `@Permissions()`: seeing the skills you have earned is not a capability an
 * organization grants, and the subject is always the caller — identity comes
 * from the token, so there is no id parameter to read someone else's.
 */
@Controller('learner/competencies')
@Roles('learner')
export class LearnerCompetenciesController {
  constructor(private readonly competencies: CompetenciesService) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const competencies = await this.competencies.listMyCompetencies(
      scope,
      user.userId,
    );
    return { competencies };
  }
}
