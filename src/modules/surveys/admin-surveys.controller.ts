import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import { type OrgScope } from '@/database/org-scope';

import {
  ListResponsesQueryDto,
  SaveTemplateDto,
} from './dto/survey.dto';
import { SurveysService } from './surveys.service';

/**
 * Surveys & Feedback, the admin's side: edit the forms, read the answers.
 *
 * `manage_courses` rather than a new permission, and that is a deliberate
 * choice with a cost either way. A new `manage_surveys` would need its own
 * grant migration to reach existing admin roles, and every such migration
 * bumps `perm_version` and signs every user in every organization out once
 * (§10.17). A feedback form is course configuration — which template a course
 * shows is literally a column on `courses` — so the permission that already
 * governs course configuration is a truthful guard rather than a convenient
 * one. If an organization ever needs to let somebody read feedback without
 * editing courses, that is the moment to add the permission and pay for the
 * migration.
 */
@Controller('admin/surveys')
@Roles('admin')
@Permissions('manage_courses')
export class AdminSurveysController {
  constructor(private readonly surveys: SurveysService) {}

  /* ── Templates ── */

  @Get('templates')
  async list(@CurrentScope() scope: OrgScope) {
    return this.surveys.listTemplates(scope);
  }

  @Get('templates/:templateId')
  async one(
    @CurrentScope() scope: OrgScope,
    @Param('templateId', ParseIntPipe) templateId: number,
  ) {
    return this.surveys.getTemplate(scope, templateId);
  }

  @Post('templates')
  async create(@CurrentScope() scope: OrgScope, @Body() dto: SaveTemplateDto) {
    return this.surveys.createTemplate(scope, dto);
  }

  /** Name, description, active flag and the whole question set in one save. */
  @Patch('templates/:templateId')
  async update(
    @CurrentScope() scope: OrgScope,
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() dto: SaveTemplateDto,
  ) {
    return this.surveys.updateTemplate(scope, templateId, dto);
  }

  @Delete('templates/:templateId')
  async remove(
    @CurrentScope() scope: OrgScope,
    @Param('templateId', ParseIntPipe) templateId: number,
  ) {
    return this.surveys.deleteTemplate(scope, templateId);
  }

  /* ── What learners said ── */

  @Get('responses')
  async responses(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListResponsesQueryDto,
  ) {
    return this.surveys.listResponses(scope, {
      courseId: query.course_id,
      templateId: query.template_id,
      limit: Math.min(query.limit ?? 50, 100),
      offset: query.offset ?? 0,
    });
  }

  /** What the page's filters and the course form's dropdown may offer. */
  @Get('options')
  async options(@CurrentScope() scope: OrgScope) {
    return this.surveys.options(scope);
  }

  /** Which form a given course resolves to — read by the course editor so it
   *  can say "Technical courses use the Technical template" truthfully. */
  @Get('courses/:courseId')
  async forCourse(
    @CurrentScope() scope: OrgScope,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.surveys.templateForCourse(scope, courseId);
  }
}
