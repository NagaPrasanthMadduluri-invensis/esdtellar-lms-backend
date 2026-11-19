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
  constructor(private readonly competencies: CompetenciesService) {}

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
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    const skills = await this.competencies.getCourseSkills(scope, courseId);
    return { skills };
  }

  @Put('course/:courseId')
  @Permissions('manage_courses')
  async setCourseSkills(
    @CurrentScope() scope: OrgScope,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: SetCourseSkillsDto,
  ) {
    return this.competencies.setCourseSkills(scope, courseId, dto);
  }
}
