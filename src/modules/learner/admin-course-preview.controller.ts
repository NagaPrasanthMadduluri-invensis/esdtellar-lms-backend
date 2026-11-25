import { Controller, Get, Param } from '@nestjs/common';

import { CrossPortal, CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import { CONTENT_READERS } from '@/common/cross-portal';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { LearnerService } from './learner.service';

/**
 * Course preview (§10.64): an Admin opens any course in their content scope
 * exactly as a learner sees it, to audit and test it, draft or published.
 * Read-only. The preview writes no progress, no watch time, no attempt and no
 * SCORM tracking. Like every content read it is open to any admin-portal role,
 * with no extra Permission (BACKEND_STRUCTURE §5.2.1).
 */
@Controller('admin')
@Roles('admin')
export class AdminCoursePreviewController {
  constructor(
    private readonly learner: LearnerService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get('courses/:courseId/preview')
  @CrossPortal(...CONTENT_READERS)
  async course(
    @Param('courseId') courseIdParam: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    const courseId = await this.publicId.resolveIdOrThrow('courses', courseIdParam);
    return this.learner.previewCourse(scope, user.userId, courseId);
  }

  @Get('lessons/:lessonId/preview')
  @CrossPortal(...CONTENT_READERS)
  async lesson(
    @Param('lessonId') lessonIdParam: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    const lessonId = await this.publicId.resolveIdOrThrow('lessons', lessonIdParam);
    return this.learner.previewLesson(scope, user.userId, lessonId);
  }
}
