import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { normalizeSkillSlug } from '@/common/competencies';
import type { OrgScope } from '@/database/org-scope';
import { CertificatesService } from '@/modules/certificates/certificates.service';

import { CompetenciesRepository } from './competencies.repository';
import type { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';
import type { SetCourseSkillsDto } from './dto/course-skills.dto';

/**
 * The competency module's business rules (0070, spec ai-insights.md Wave 0).
 *
 * Two jobs: let an admin curate skills and map them to courses, and record a
 * learner's gained competencies when a course completes. The recording re-uses
 * the ONE completion definition (`CertificatesService.isCourseComplete`) rather
 * than writing a second one, and is best-effort — it can never break the lesson
 * or assessment flow that triggered it.
 */
@Injectable()
export class CompetenciesService {
  private readonly logger = new Logger('Competencies');

  constructor(
    private readonly repository: CompetenciesRepository,
    private readonly certificates: CertificatesService,
  ) {}

  listSkills(scope: OrgScope, includeArchived: boolean) {
    return this.repository.listSkills(scope, includeArchived);
  }

  async createSkill(scope: OrgScope, dto: CreateSkillDto) {
    const slug = normalizeSkillSlug(dto.name);
    if (!slug) {
      throw new BadRequestException('A skill name must contain letters or numbers.');
    }
    if (await this.repository.slugExists(scope, slug)) {
      throw new ConflictException('A skill with that name already exists.');
    }
    const id = await this.repository.createSkill(scope, {
      name: dto.name,
      slug,
      domain: dto.domain ?? null,
    });
    return {
      id,
      name: dto.name,
      slug,
      domain: dto.domain ?? null,
      is_active: 1,
      is_shared: false,
      course_count: 0,
      learner_count: 0,
    };
  }

  async updateSkill(scope: OrgScope, id: number, dto: UpdateSkillDto) {
    const existing = await this.repository.findOwnedSkill(scope, id);
    // A shared platform skill is not the tenant's to rename or archive, and a
    // non-existent one must look identical to it (§5.3) — both are a 404 here.
    if (!existing) {
      throw new NotFoundException('Skill not found.');
    }

    const patch: {
      name?: string;
      slug?: string;
      domain?: string | null;
      isActive?: number;
    } = {};

    if (dto.name !== undefined) {
      const slug = normalizeSkillSlug(dto.name);
      if (!slug) {
        throw new BadRequestException('A skill name must contain letters or numbers.');
      }
      if (await this.repository.slugExists(scope, slug, id)) {
        throw new ConflictException('A skill with that name already exists.');
      }
      patch.name = dto.name;
      patch.slug = slug;
    }
    if (dto.domain !== undefined) patch.domain = dto.domain;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive ? 1 : 0;

    await this.repository.updateSkill(scope, id, patch);
    return this.repository.findOwnedSkill(scope, id);
  }

  getCourseSkills(scope: OrgScope, courseId: number) {
    return this.repository.getCourseSkills(scope, courseId);
  }

  async setCourseSkills(scope: OrgScope, courseId: number, dto: SetCourseSkillsDto) {
    // Only a course this org owns may have its mapping edited; a shared platform
    // course belongs to the platform admin, and a missing one 404s the same way.
    if (!(await this.repository.courseIsOwned(scope, courseId))) {
      throw new NotFoundException('Course not found.');
    }
    const count = await this.repository.setCourseSkills(
      scope,
      courseId,
      dto.skills.map((s) => ({ skillId: s.skillId, level: s.level })),
    );
    return { ok: true, count };
  }

  listMyCompetencies(scope: OrgScope, userId: number) {
    return this.repository.listUserCompetencies(scope, userId);
  }

  /**
   * Record competencies when a course completes. Called best-effort at the three
   * completion seams (scorm, assessments, learner) beside `autoIssue` and
   * `onCourseProgress`. It re-derives completion through the one definition, so a
   * call on a lesson that is NOT the last one is a no-op, and it never throws
   * into the caller (§8.4).
   */
  async onCourseCompleted(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<void> {
    try {
      if (!(await this.certificates.isCourseComplete(scope, userId, courseId))) {
        return;
      }
      await this.repository.recordCourseSkills(scope, userId, courseId);
    } catch (error) {
      this.logger.warn(
        `Competency recording skipped for user=${userId} course=${courseId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
