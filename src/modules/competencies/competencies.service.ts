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

  async getCourseSkills(scope: OrgScope, courseId: number) {
    // Another tenant's course 404s like a missing one; a shared platform course
    // is readable, as the course itself is.
    if (!(await this.repository.courseIsVisible(scope, courseId))) {
      throw new NotFoundException('Course not found.');
    }
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
    // People who ALREADY completed the course gain the skills now. Skills were
    // only ever recorded at the moment of completion, so tagging a course
    // after people finished it left them with nothing (2026-11-24).
    const awarded = count > 0 ? await this.awardToCompleters(scope, courseId) : 0;
    return { ok: true, count, awarded };
  }

  /**
   * Record the course's skills for everyone who has completed it. Candidates
   * are narrowed in SQL (assigned, active, at least one lesson done), then each
   * is checked with the ONE completion definition. Bounded by one course's
   * assignments and run only when an admin saves the mapping. Returns how many
   * people were recorded. Best-effort per person: one failure never blocks the
   * save or the rest.
   */
  async awardToCompleters(scope: OrgScope, courseId: number): Promise<number> {
    const candidates = await this.repository.completionCandidates(scope, courseId);
    let awarded = 0;
    for (const userId of candidates) {
      try {
        if (await this.certificates.isCourseComplete(scope, userId, courseId)) {
          await this.repository.recordCourseSkills(scope, userId, courseId);
          awarded += 1;
        }
      } catch (error) {
        this.logger.warn(
          `Skill award skipped for user=${userId} course=${courseId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return awarded;
  }

  /** A course's skills for one learner, each marked earned or not. */
  async courseSkillsFor(scope: OrgScope, courseId: number, userId: number) {
    const rows = await this.repository.courseSkillsForLearner(scope, courseId, userId);
    return rows.map((r) => ({
      skillId: r.skill_id,
      name: r.name,
      domain: r.domain,
      level: r.level,
      earned: r.earned === true,
      heldLevel: r.held_level,
    }));
  }

  /**
   * The admin's Skills and competencies page: who holds what, at which level,
   * how that grew month by month, coverage per department, and the courses
   * that teach no skill yet. Every figure is read from `user_skills`, the same
   * rows a learner's own skills come from.
   */
  async skillsAnalytics(scope: OrgScope) {
    const MONTHS = 12;
    const [coverage, holders, trend, byDomain, departments, untagged, activeLearners] =
      await Promise.all([
        this.repository.skillCoverage(scope),
        this.repository.skillHolders(scope, 2000),
        this.repository.skillTrend(scope, MONTHS),
        this.repository.skillTrendByDomain(scope, MONTHS),
        this.repository.departmentCoverage(scope),
        this.repository.untaggedCourses(scope),
        this.repository.activeLearnerCount(scope),
      ]);

    const holdersBySkill = new Map<number, { userId: number; name: string; department: string | null; jobRole: string | null; level: string; earnedAt: string }[]>();
    for (const h of holders) {
      const list = holdersBySkill.get(h.skill_id) ?? [];
      list.push({
        userId: h.user_id,
        name: h.name,
        department: h.department,
        jobRole: h.job_role,
        level: h.level,
        earnedAt: h.earned_at,
      });
      holdersBySkill.set(h.skill_id, list);
    }

    const domains = Array.from(new Set(coverage.map((c) => c.domain))).sort();
    const domainSeries = trend.map((t) => {
      const row: Record<string, string | number> = { month: t.month };
      for (const d of domains) row[d] = 0;
      for (const b of byDomain) if (b.month === t.month) row[b.domain] = b.earned;
      return row;
    });

    const peopleWithSkills = new Set(holders.map((h) => h.user_id)).size;
    const held = coverage.filter((c) => c.people > 0);
    const totalAwards = coverage.reduce((n, c) => n + c.people, 0);

    return {
      kpis: {
        activeLearners,
        peopleWithSkills,
        coveragePct: activeLearners > 0 ? Math.round((peopleWithSkills / activeLearners) * 100) : null,
        skillsHeld: held.length,
        totalAwards,
        avgPerPerson: peopleWithSkills > 0 ? Math.round((totalAwards / peopleWithSkills) * 10) / 10 : null,
        earnedThisMonth: trend.at(-1)?.earned ?? 0,
      },
      skills: coverage.map((c) => ({
        skillId: c.skill_id,
        name: c.name,
        domain: c.domain,
        people: c.people,
        levels: { beginner: c.beginner, intermediate: c.intermediate, advanced: c.advanced },
        coursesTagged: c.courses_tagged,
        holders: holdersBySkill.get(c.skill_id) ?? [],
      })),
      domains: domains.map((d) => ({
        domain: d,
        people: new Set(
          holders.filter((h) => coverage.find((c) => c.skill_id === h.skill_id)?.domain === d).map((h) => h.user_id),
        ).size,
        skills: coverage.filter((c) => c.domain === d && c.people > 0).length,
      })),
      trend: trend.map((t) => ({ month: t.month, earned: t.earned, learners: t.learners, holders: t.holders })),
      trendByDomain: { domains, series: domainSeries },
      departments: departments.map((d) => ({
        department: d.department,
        headcount: d.headcount,
        withSkills: d.with_skills,
        skillsHeld: d.skills_held,
        coveragePct: d.headcount > 0 ? Math.round((d.with_skills / d.headcount) * 100) : 0,
      })),
      untaggedCourses: untagged.map((c) => ({ id: c.public_id ?? c.id, name: c.name, learners: c.learners })),
    };
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
