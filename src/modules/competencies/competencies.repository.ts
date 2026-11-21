import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import {
  contentScope,
  orgScope,
  type OrgScope,
} from '@/database/org-scope';

export interface SkillRow {
  id: number;
  name: string;
  slug: string;
  domain: string | null;
  is_active: number;
  organization_id: number;
  is_shared: boolean;
  course_count: number;
  learner_count: number;
}

export interface CourseSkillRow {
  skill_id: number;
  name: string;
  domain: string | null;
  level: string;
}

export interface UserCompetencyRow {
  skill_id: number;
  skill: string;
  domain: string | null;
  level: string;
  earned_at: string;
  last_reinforced_at: string;
  source_course: string | null;
}

/**
 * The competency data layer (0070). Every read states its scope explicitly:
 * a skill or a course mapping is CONTENT (`contentScope` — platform rows are
 * shared), a learner's gained competency and any count over learners is ACTIVITY
 * (`orgScope`). The split follows §10.12 so a shared skill never shows one tenant
 * another tenant's learner counts.
 */
@Injectable()
export class CompetenciesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Skills this admin may use: their own org's plus the platform's shared set.
   * `course_count` is `contentScope` (counting COURSES, which may be shared);
   * `learner_count` is `orgScope` (counting this tenant's learners only).
   */
  async listSkills(scope: OrgScope, includeArchived: boolean): Promise<SkillRow[]> {
    const activeFilter = includeArchived ? sql`` : sql`AND s.is_active = 1`;
    return this.db.all<SkillRow>(sql`
      SELECT
        s.id,
        s.name,
        s.slug,
        s.domain,
        s.is_active,
        s.organization_id,
        (s.organization_id = ${scope.platformOrganizationId}) AS is_shared,
        (
          SELECT COUNT(*)::int
          FROM course_skills cs
          JOIN courses c ON c.id = cs.course_id AND ${contentScope('c', scope)}
          WHERE cs.skill_id = s.id
        ) AS course_count,
        (
          SELECT COUNT(*)::int
          FROM user_skills us
          WHERE us.skill_id = s.id AND ${orgScope('us', scope)}
        ) AS learner_count
      FROM skills s
      WHERE ${contentScope('s', scope)} ${activeFilter}
      ORDER BY s.domain NULLS LAST, s.name
    `);
  }

  /** A skill OWNED by this org (never a platform one) — for mutation. */
  async findOwnedSkill(scope: OrgScope, id: number): Promise<SkillRow | null> {
    const rows = await this.db.all<SkillRow>(sql`
      SELECT s.id, s.name, s.slug, s.domain, s.is_active, s.organization_id,
             false AS is_shared, 0 AS course_count, 0 AS learner_count
      FROM skills s
      WHERE s.id = ${id} AND ${orgScope('s', scope)}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async slugExists(scope: OrgScope, slug: string, exceptId?: number): Promise<boolean> {
    const except = exceptId ? sql`AND s.id <> ${exceptId}` : sql``;
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM skills s
      WHERE s.organization_id = ${scope.organizationId} AND s.slug = ${slug} ${except}
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async createSkill(
    scope: OrgScope,
    input: { name: string; slug: string; domain: string | null },
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO skills (organization_id, name, slug, domain)
      VALUES (${scope.organizationId}, ${input.name}, ${input.slug}, ${input.domain})
      RETURNING id
    `);
    return Number(rows[0].id);
  }

  /** Patch an OWNED skill. The caller has already checked ownership (404s otherwise). */
  async updateSkill(
    scope: OrgScope,
    id: number,
    patch: { name?: string; slug?: string; domain?: string | null; isActive?: number },
  ): Promise<void> {
    const sets: SQL[] = [];
    if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
    if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`);
    if (patch.domain !== undefined) sets.push(sql`domain = ${patch.domain}`);
    if (patch.isActive !== undefined) sets.push(sql`is_active = ${patch.isActive}`);
    sets.push(sql`updated_at = now()`);
    await this.db.run(sql`
      UPDATE skills s SET ${sql.join(sets, sql`, `)}
      WHERE s.id = ${id} AND ${orgScope('s', scope)}
    `);
  }

  /** True when the course exists AND is owned by this org (not a shared platform course). */
  async courseIsOwned(scope: OrgScope, courseId: number): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM courses c
      WHERE c.id = ${courseId} AND ${orgScope('c', scope)}
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** True when the course is visible to this org: its own or a shared platform course. */
  async courseIsVisible(scope: OrgScope, courseId: number): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM courses c
      WHERE c.id = ${courseId} AND ${contentScope('c', scope)}
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** The skills mapped to a course (viewable across content scope). */
  async getCourseSkills(scope: OrgScope, courseId: number): Promise<CourseSkillRow[]> {
    return this.db.all<CourseSkillRow>(sql`
      SELECT cs.skill_id, s.name, s.domain, cs.level
      FROM course_skills cs
      JOIN skills s ON s.id = cs.skill_id
      WHERE cs.course_id = ${courseId} AND ${contentScope('s', scope)}
      ORDER BY s.name
    `);
  }

  /**
   * Replace a course's skill set. Only skills visible to this org
   * (`contentScope`, active) are accepted — an id for another tenant's skill is
   * silently dropped rather than attached, so the mapping cannot become a
   * cross-tenant reference. Returns how many were written.
   */
  async setCourseSkills(
    scope: OrgScope,
    courseId: number,
    skills: { skillId: number; level: string }[],
  ): Promise<number> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM course_skills WHERE course_id = ${courseId}`);
      if (skills.length === 0) return;
      const values = sql.join(
        skills.map((s) => sql`(${s.skillId}::int, ${s.level}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO course_skills (course_id, skill_id, level)
        SELECT ${courseId}, x.skill_id, x.level
        FROM (VALUES ${values}) AS x (skill_id, level)
        JOIN skills s ON s.id = x.skill_id AND ${contentScope('s', scope)} AND s.is_active = 1
        ON CONFLICT (course_id, skill_id) DO UPDATE SET level = excluded.level
      `);
    });
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM course_skills WHERE course_id = ${courseId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Record the completing course's skills against the learner, in their own org.
   * One statement, idempotent: a replay only refreshes `source_course_id` and
   * `last_reinforced_at`, and `level` is UPGRADED by rank (never downgraded) so a
   * later advanced course can lift a skill a beginner one first granted.
   */
  async recordCourseSkills(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_skills
        (organization_id, user_id, skill_id, level, source_course_id, earned_at, last_reinforced_at)
      SELECT ${scope.organizationId}, ${userId}, cs.skill_id, cs.level, ${courseId}, now(), now()
      FROM course_skills cs
      JOIN skills s ON s.id = cs.skill_id AND s.is_active = 1
      WHERE cs.course_id = ${courseId}
      ON CONFLICT (user_id, skill_id) DO UPDATE SET
        level = CASE
          WHEN (CASE excluded.level WHEN 'advanced' THEN 3 WHEN 'intermediate' THEN 2 WHEN 'beginner' THEN 1 ELSE 0 END)
             >  (CASE user_skills.level WHEN 'advanced' THEN 3 WHEN 'intermediate' THEN 2 WHEN 'beginner' THEN 1 ELSE 0 END)
          THEN excluded.level ELSE user_skills.level END,
        source_course_id = excluded.source_course_id,
        last_reinforced_at = now()
    `);
  }

  /** A learner's own gained competencies. ACTIVITY, so `orgScope`. */
  async listUserCompetencies(
    scope: OrgScope,
    userId: number,
  ): Promise<UserCompetencyRow[]> {
    return this.db.all<UserCompetencyRow>(sql`
      SELECT us.skill_id, s.name AS skill, s.domain, us.level,
             us.earned_at, us.last_reinforced_at, c.name AS source_course
      FROM user_skills us
      JOIN skills s ON s.id = us.skill_id
      LEFT JOIN courses c ON c.id = us.source_course_id
      WHERE ${orgScope('us', scope)} AND us.user_id = ${userId}
      ORDER BY s.domain NULLS LAST, s.name
    `);
  }
}
