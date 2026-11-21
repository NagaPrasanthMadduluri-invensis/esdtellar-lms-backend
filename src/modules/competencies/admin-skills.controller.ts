import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { CompetenciesService } from './competencies.service';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';
import {
  ListSkillsQueryDto,
  SetCourseSkillsDto,
} from './dto/course-skills.dto';

/**
 * Admin curation of the competency catalogue and the course→skill mapping
 * (spec ai-insights.md Wave 0).
 *
 * Guarded by `manage_courses`, not a new permission: which skills a course
 * imparts is a property of the course, and a dedicated permission would need a
 * grant migration that bumps `perm_version` and signs every org out once
 * (§10.24's reasoning).
 */
@Controller('admin/skills')
@Roles('admin')
export class AdminSkillsController {
  constructor(
    private readonly competencies: CompetenciesService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get()
  @Permissions('manage_courses')
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListSkillsQueryDto,
  ) {
    const skills = await this.competencies.listSkills(
      scope,
      query.archived === 'true',
    );
    return { skills };
  }

  @Post()
  @Permissions('manage_courses')
  async create(@CurrentScope() scope: OrgScope, @Body() dto: CreateSkillDto) {
    const skill = await this.competencies.createSkill(scope, dto);
    return { skill };
  }

  @Patch(':id')
  @Permissions('manage_courses')
  async update(
    @CurrentScope() scope: OrgScope,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSkillDto,
  ) {
    const skill = await this.competencies.updateSkill(scope, id, dto);
    return { skill };
  }

  @Get('course/:courseId')
  @Permissions('manage_courses')
  async courseSkills(
    @CurrentScope() scope: OrgScope,
    @Param('courseId') courseIdParam: string,
  ) {
    // The Course page passes the course's public UUID; integer ids still work.
    const courseId = await this.publicId.resolveIdOrThrow('courses', courseIdParam);
    const skills = await this.competencies.getCourseSkills(scope, courseId);
    return { skills };
  }

  @Put('course/:courseId')
  @Permissions('manage_courses')
  async setCourseSkills(
    @CurrentScope() scope: OrgScope,
    @Param('courseId') courseIdParam: string,
    @Body() dto: SetCourseSkillsDto,
  ) {
    const courseId = await this.publicId.resolveIdOrThrow('courses', courseIdParam);
    return this.competencies.setCourseSkills(scope, courseId, dto);
  }
}
