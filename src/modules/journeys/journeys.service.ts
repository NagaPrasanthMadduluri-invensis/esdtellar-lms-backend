import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { MediaService } from '@/modules/media/media.service';
import type { OrgScope } from '@/database/org-scope';
import { journeyBadgeKey } from '@/common/badges';
import { BadgesService } from '@/modules/badges/badges.service';
import { CertificatesService } from '@/modules/certificates/certificates.service';

import type { AssignJourneyDto } from './dto/assign-journey.dto';
import type {
  JourneyDto,
  ListJourneyLearnersQueryDto,
  BulkJourneysDto,
  ListJourneysQueryDto,
  SetJourneyCoursesDto,
} from './dto/journey.dto';
import { JourneyGateService } from './journey-gate.service';
import { JourneysRepository, type JourneyStep, type LearnerMatch } from './journeys.repository';

@Injectable()
export class JourneysService {
  private readonly logger = new Logger(JourneysService.name);

  constructor(
    private readonly repository: JourneysRepository,
    private readonly media: MediaService,
    private readonly certificates: CertificatesService,
    private readonly badges: BadgesService,
    private readonly gate: JourneyGateService,
  ) {}

  /* ── Shaping ── */

  private shape(journey: {
    id: number;
    organizationId: number;
    title: string;
    description: string | null;
    tag: string | null;
    skills: string | null;
    thumbnailUrl: string | null;
    badgeLabel: string;
    badgeIcon: string;
    pointsBonus: number;
    isActive: number;
    createdAt: string;
    updatedAt: string;
  }) {
    return {
      id: journey.id,
      organization_id: journey.organizationId,
      title: journey.title,
      description: journey.description,
      tag: journey.tag,
      skills: journey.skills,
      thumbnail_url: journey.thumbnailUrl,
      badge_label: journey.badgeLabel,
      badge_icon: journey.badgeIcon,
      points_bonus: journey.pointsBonus,
      is_active: Number(journey.isActive) === 1,
      created_at: journey.createdAt,
      updated_at: journey.updatedAt,
    };
  }

  private deriveProgress(
    totalRequired: number,
    completedRequired: number,
    completedAt: string | null,
  ) {
    const percent =
      totalRequired > 0 ? Math.round((completedRequired / totalRequired) * 100) : 0;
    const status: 'complete' | 'in_progress' | 'not_started' = completedAt
      ? 'complete'
      : completedRequired > 0
        ? 'in_progress'
        : 'not_started';
    return { percent, status };
  }

  /**
   * Refuses a write to platform-owned (global) content with 422 — same shape
   * as `CoursesService.assertNotGlobalContent` (spec §3.4, acceptance 14).
   */
  private assertNotGlobalContent(
    scope: OrgScope,
    organizationId: number,
    what = 'journey',
  ): void {
    if (organizationId !== scope.organizationId) {
      throw new UnprocessableEntityException(
        `This ${what} is published by the platform administrator and cannot be edited here.`,
      );
    }
  }

  /* ── Admin: CRUD ── */

  async listForAdmin(scope: OrgScope, query: ListJourneysQueryDto) {
    const filters = {
      status: query.status,
      archived: query.archived ?? false,
      limit: query.limit,
      offset: query.offset,
    };
    const [rows, total, archivedCount] = await Promise.all([
      this.repository.listForAdmin(scope, filters),
      this.repository.countForAdmin(scope, {
        status: query.status,
        archived: filters.archived,
      }),
      this.repository.archivedCount(scope),
    ]);

    return {
      journeys: rows.map((row) => ({
        id: row.id,
        organization_id: row.organization_id,
        title: row.title,
        description: row.description,
        tag: row.tag,
        skills: row.skills,
        thumbnail_url: row.thumbnail_url,
        badge_label: row.badge_label,
        badge_icon: row.badge_icon,
        points_bonus: row.points_bonus,
        is_active: Number(row.is_active) === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
        courses_count: Number(row.courses_count),
        learners_count: Number(row.learners_count),
        completed_count: Number(row.completed_count),
        completion_pct: Number(row.completion_pct),
        // NULL when nobody has been scored. Kept null rather than coerced to
        // 0 — "no score yet" and "averaged zero" are different facts and the
        // card renders them differently.
        avg_score: row.avg_score === null ? null : Number(row.avg_score),
      })),
      total,
      archived_count: archivedCount,
    };
  }

  /**
   * Bulk action from the builder's selection bar.
   *
   * One statement per action (§7.1), and the repository's predicates are the
   * guards: org-owned only, and activate skips anything archived. Ids that
   * fail them are simply not affected, and the count says how many were — a
   * selection spanning a platform-owned path reports 3 of 4 rather than
   * erroring on the one it could not touch.
   */
  async bulk(scope: OrgScope, dto: BulkJourneysDto) {
    const { ids, action } = dto;
    let affected = 0;

    if (action === 'archive') affected = await this.repository.setArchived(scope, ids, true);
    else if (action === 'restore') affected = await this.repository.setArchived(scope, ids, false);
    else if (action === 'activate') affected = await this.repository.setActive(scope, ids, true);
    else if (action === 'draft') affected = await this.repository.setActive(scope, ids, false);
    else affected = await this.repository.deleteMany(scope, ids);

    return { affected, requested: ids.length, action };
  }

  async create(scope: OrgScope, dto: JourneyDto) {
    const journey = await this.repository.createJourney(scope, {
      title: dto.title,
      description: dto.description ?? null,
      tag: dto.tag ?? null,
      skills: dto.skills ?? null,
      thumbnailUrl: dto.thumbnail_url
        ? this.media.assertCourseThumbnail(dto.thumbnail_url)
        : null,
      badgeLabel: dto.badge_label,
      badgeIcon: dto.badge_icon ?? 'award',
      pointsBonus: dto.points_bonus ?? 200,
      isActive: (dto.is_active ?? true) ? 1 : 0,
    });
    return { journey: this.shape(journey) };
  }

  async get(scope: OrgScope, journeyId: number) {
    const journey = await this.repository.findById(scope, journeyId);
    if (!journey) throw new NotFoundException('Journey not found');

    const courses = await this.repository.listCourses(scope, journeyId);
    return {
      journey: {
        ...this.shape(journey),
        courses: courses.map((c) => ({
          id: c.id,
          course_id: c.course_id,
          course_name: c.course_name,
          thumbnail_url: c.thumbnail_url,
          sort_order: c.sort_order,
          is_required: Number(c.is_required) === 1,
        })),
      },
    };
  }

  async update(scope: OrgScope, journeyId: number, dto: JourneyDto) {
    const existing = await this.repository.findById(scope, journeyId);
    if (!existing) throw new NotFoundException('Journey not found');
    this.assertNotGlobalContent(scope, existing.organizationId, 'journey');

    const thumbnailUrl =
      dto.thumbnail_url === undefined
        ? existing.thumbnailUrl
        : dto.thumbnail_url === null
          ? null
          : this.media.assertCourseThumbnail(dto.thumbnail_url);

    const updated = await this.repository.updateJourney(scope, journeyId, {
      title: dto.title,
      description: dto.description ?? null,
      tag: dto.tag ?? null,
      skills: dto.skills ?? null,
      thumbnailUrl,
      badgeLabel: dto.badge_label,
      badgeIcon: dto.badge_icon ?? existing.badgeIcon,
      pointsBonus: dto.points_bonus ?? existing.pointsBonus,
      isActive: dto.is_active === undefined ? existing.isActive : dto.is_active ? 1 : 0,
    });
    // Cannot be null: `existing` above already proved the row is in scope.
    return { journey: this.shape(updated!) };
  }

  async remove(scope: OrgScope, journeyId: number) {
    const existing = await this.repository.findById(scope, journeyId);
    if (!existing) throw new NotFoundException('Journey not found');
    this.assertNotGlobalContent(scope, existing.organizationId, 'journey');

    await this.repository.deleteJourney(scope, journeyId);
    return { message: 'Journey deleted' };
  }

  /** Replaces the ordered course list. §6 acceptance 1, 2. */
  async setCourses(scope: OrgScope, journeyId: number, dto: SetJourneyCoursesDto) {
    const existing = await this.repository.findById(scope, journeyId);
    if (!existing) throw new NotFoundException('Journey not found');
    this.assertNotGlobalContent(scope, existing.organizationId, 'journey');

    const courseIds = dto.courses.map((c) => c.course_id);
    const uniqueIds = new Set(courseIds);
    if (uniqueIds.size !== courseIds.length) {
      throw new UnprocessableEntityException('A course cannot appear twice in a journey');
    }

    const inScope = await this.repository.filterCoursesInScope(scope, courseIds);
    if (inScope.length !== courseIds.length) {
      throw new NotFoundException('One or more courses were not found');
    }

    await this.repository.replaceCourses(
      scope,
      journeyId,
      dto.courses.map((c, index) => ({
        courseId: c.course_id,
        sortOrder: c.sort_order ?? index,
        isRequired: c.is_required ?? true,
      })),
    );

    const courses = await this.repository.listCourses(scope, journeyId);
    return {
      courses: courses.map((c) => ({
        id: c.id,
        course_id: c.course_id,
        course_name: c.course_name,
        thumbnail_url: c.thumbnail_url,
        sort_order: c.sort_order,
        is_required: Number(c.is_required) === 1,
      })),
    };
  }

  /* ── Admin: learners on a journey ── */

  async listLearners(scope: OrgScope, journeyId: number, query: ListJourneyLearnersQueryDto) {
    const journey = await this.repository.findById(scope, journeyId);
    if (!journey) throw new NotFoundException('Journey not found');

    const pagination = { limit: query.limit, offset: query.offset };
    const [rows, total] = await Promise.all([
      this.repository.listLearners(scope, journeyId, pagination),
      this.repository.countLearners(scope, journeyId),
    ]);

    return {
      learners: rows.map((row) => {
        const { percent, status } = this.deriveProgress(
          Number(row.total_required),
          Number(row.completed_required),
          row.completed_at,
        );
        return {
          user_id: row.user_id,
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          assigned_at: row.assigned_at,
          due_date: row.due_date,
          completed_at: row.completed_at,
          percent,
          status,
          current_step: row.next_course_name,
        };
      }),
      total,
    };
  }

  /* ── Admin: assign / unassign (spec §4.1 acceptance 3, 4) ── */

  private buildMatch(dto: AssignJourneyDto): LearnerMatch {
    const hasUserIds = Array.isArray(dto.user_ids) && dto.user_ids.length > 0;
    const hasDepartment = typeof dto.department === 'string' && dto.department.trim().length > 0;

    if (hasUserIds === hasDepartment) {
      throw new UnprocessableEntityException(
        'Provide either user_ids or a department, not both or neither.',
      );
    }

    return hasUserIds
      ? { kind: 'ids', userIds: dto.user_ids! }
      : { kind: 'department', department: dto.department!.trim() };
  }

  async assign(scope: OrgScope, journeyId: number, dto: AssignJourneyDto, adminId: number) {
    const journey = await this.repository.findById(scope, journeyId);
    if (!journey) throw new NotFoundException('Journey not found');

    const rawMatch = this.buildMatch(dto);
    const dueDate = dto.due_date ?? null;

    // Narrow the target set and its size BEFORE inserting, so "skipped" means
    // something (already enrolled) rather than folding in bad ids silently.
    let targetCount: number;
    let match: LearnerMatch;
    if (rawMatch.kind === 'ids') {
      const inScope = await this.repository.filterLearnersInOrg(scope, rawMatch.userIds);
      match = { kind: 'ids', userIds: inScope };
      targetCount = inScope.length;
    } else {
      match = rawMatch;
      targetCount = await this.repository.countActiveLearnersInDepartment(
        scope,
        rawMatch.department,
      );
    }

    if (targetCount === 0) return { assigned: 0, skipped: 0 };

    // Two set-based statements, no `await` inside a loop (§7.1, acceptance 3).
    const assigned = await this.repository.enrollLearners(
      scope,
      journeyId,
      match,
      adminId,
      dueDate,
    );
    await this.repository.assignJourneyCourses(scope, journeyId, match, adminId, dueDate);

    return { assigned, skipped: targetCount - assigned };
  }

  async unassign(scope: OrgScope, journeyId: number, userId: number) {
    const journey = await this.repository.findById(scope, journeyId);
    if (!journey) throw new NotFoundException('Journey not found');

    const enrollment = await this.repository.findEnrollment(scope, userId, journeyId);
    if (!enrollment) throw new NotFoundException('Learner is not on this journey');

    await this.repository.removeEnrollment(scope, journeyId, userId);
    // Withdraws only the course assignments THIS journey created — a direct
    // assignment (source_journey_id NULL) is left in place (spec §4.3).
    await this.repository.withdrawJourneyCourseAssignments(scope, journeyId, userId);

    return { message: 'Learner removed from journey' };
  }

  /* ── Learner reads ── */

  async listForLearner(
    scope: OrgScope,
    userId: number,
    pagination: { limit?: number; offset?: number } = {},
  ) {
    // Paginated like every other list (§7.6). A learner's paths are few today,
    // but the count grows with every journey an org assigns them.
    const rows = await this.repository.listForLearner(scope, userId, {
      limit: Math.min(Math.max(pagination.limit ?? 50, 1), 100),
      offset: Math.max(pagination.offset ?? 0, 0),
    });
    return {
      journeys: rows.map((row) => {
        const { percent, status } = this.deriveProgress(
          Number(row.total_required),
          Number(row.completed_required),
          row.completed_at,
        );
        return {
          id: row.journey_id,
          title: row.title,
          description: row.description,
          tag: row.tag,
          skills: row.skills,
          thumbnail_url: row.thumbnail_url,
          badge_label: row.badge_label,
          badge_icon: row.badge_icon,
          points_bonus: row.points_bonus,
          assigned_at: row.assigned_at,
          due_date: row.due_date,
          completed_at: row.completed_at,
          percent,
          status,
          current_step: row.next_course_name,
        };
      }),
    };
  }

  private stepStatus(
    steps: JourneyStep[],
    index: number,
    journeyId: number,
  ): 'locked' | 'open' | 'complete' {
    const step = steps[index];
    if (step.isComplete) return 'complete';
    // No assignment row at all: never assigned, so it is not open (§4.3 —
    // "no row: not assigned; not shown"). Conservative default: locked.
    if (!step.hasAssignment) return 'locked';
    // Assigned directly (NULL), or gated by a DIFFERENT journey than the one
    // being viewed: this journey's order does not apply to it.
    if (step.sourceJourneyId === null || step.sourceJourneyId !== journeyId) return 'open';

    const earlierIncomplete = steps
      .slice(0, index)
      .some((earlier) => earlier.isRequired && !earlier.isComplete);
    return earlierIncomplete ? 'locked' : 'open';
  }

  async getForLearner(scope: OrgScope, userId: number, journeyId: number) {
    const enrollment = await this.repository.findEnrollment(scope, userId, journeyId);
    if (!enrollment) throw new NotFoundException('Journey not found');

    const journey = await this.repository.findById(scope, journeyId);
    if (!journey) throw new NotFoundException('Journey not found');

    const steps = await this.repository.getJourneySteps(scope, journeyId, userId);
    const totalRequired = steps.filter((s) => s.isRequired).length;
    const completedRequired = steps.filter((s) => s.isRequired && s.isComplete).length;
    const { percent, status } = this.deriveProgress(
      totalRequired,
      completedRequired,
      enrollment.completedAt,
    );

    return {
      journey: {
        ...this.shape(journey),
        percent,
        status,
        courses: steps.map((step, index) => ({
          course_id: step.courseId,
          course_name: step.courseName,
          thumbnail_url: step.thumbnailUrl,
          sort_order: step.sortOrder,
          is_required: step.isRequired,
          status: this.stepStatus(steps, index, journeyId),
        })),
      },
    };
  }

  /* ── Sequential gating, used by the learner lesson routes (spec §4.3) ── */

  /** Plain read: is this course currently locked for this learner on this journey? */
  async isCourseLockedFor(
    scope: OrgScope,
    userId: number,
    journeyId: number,
    courseId: number,
  ): Promise<boolean> {
    const steps = await this.repository.getJourneySteps(scope, journeyId, userId);
    const index = steps.findIndex((s) => s.courseId === courseId);
    if (index === -1) return false;
    return this.stepStatus(steps, index, journeyId) === 'locked';
  }

  /**
   * Enforcement: throws 403 when this course is gated shut for this learner.
   * A course assigned directly (`source_journey_id IS NULL`) always passes —
   * a course is never locked globally, only its position inside a journey is
   * (spec §4.3). Wired into the learner lesson routes in a later change.
   */
  async assertCourseUnlocked(scope: OrgScope, userId: number, courseId: number): Promise<void> {
    // Delegated so the rule has ONE implementation. Content-delivery paths in
    // other modules call JourneyGateService directly (it has no dependencies);
    // this wrapper exists for callers that already hold JourneysService.
    await this.gate.assertUnlocked(scope, userId, courseId);
  }

  /**
   * Best-effort completion check, called on the same three triggers
   * `CertificatesService.autoIssue` already uses — lesson complete,
   * assessment submitted, SCORM commit (spec §4.2) — and nowhere else.
   *
   * MUST NOT throw into the caller (§8.4): a journey bookkeeping failure
   * cannot break marking a lesson complete.
   *
   * TODO(wave3): on a newly-detected completion this stub only stamps
   * `completed_at`. The reward side — issuing the journey certificate,
   * awarding the journey badge (`journey:<id>`), re-checking the
   * `journey_first` / `journey_three` / `journey_five` milestone badges, and
   * the leaderboard's `points_bonus` term — is implemented by the agent
   * building certificates/badges/leaderboard for this feature (spec §4.2,
   * §4.4, §4.5) and wires into the `markCompleted` return value below (it is
   * `true` only the moment completion is newly detected, `false` on a replay
   * — which is exactly the idempotency acceptance criterion 12 needs).
   */
  async onCourseProgress(scope: OrgScope, userId: number, courseId: number): Promise<void> {
    try {
      // ONE query to find the (usually one) journeys this course could
      // complete — the loop below is then one query PER JOURNEY, never per
      // course, which is the shape spec §4.2/§7.2 explicitly allows.
      const journeyIds = await this.repository.findEnrolledJourneysContainingCourse(
        scope,
        userId,
        courseId,
      );

      for (const journeyId of journeyIds) {
        const steps = await this.repository.getJourneySteps(scope, journeyId, userId);
        const required = steps.filter((step) => step.isRequired);
        // A journey with no required step is never "finished" — `every()` on an
        // empty list is true, which would have paid out the certificate, badge
        // and bonus on the learner's first completed lesson.
        if (required.length === 0) continue;
        if (!required.every((step) => step.isComplete)) continue;

        // `markCompleted` stamps `completed_at` only when it was NULL and
        // reports whether it actually did. Every reward below therefore fires
        // exactly once per learner per journey, however many times a trigger
        // replays (spec acceptance criterion 12).
        const newlyCompleted = await this.repository.markCompleted(scope, journeyId, userId);

        /**
         * Deliberately OUTSIDE the `newlyCompleted` guard.
         *
         * `markCompleted` stamps `completed_at` once and returns false ever
         * after, so hanging the rewards off it made them fire-once: any
         * failure — a transient database error, or the certificate insert
         * running before `migrate-journey-certificates.mjs --commit` has made
         * `course_id` nullable — was logged and then unreachable forever, and
         * the learner never got the certificate they had earned.
         *
         * Every issuer below is idempotent (`findByUserAndJourney` guards the
         * certificate, `ON CONFLICT DO NOTHING` the badge), so running them on
         * each trigger for an already-complete journey costs two indexed
         * lookups and makes the payout self-healing on the next lesson the
         * learner finishes.
         *
         * Each is independently best-effort: none may break marking a lesson
         * complete (§8.4).
         *
         * Points are NOT awarded here and there is no row to write for them —
         * `LeaderboardRepository.standings()` sums `journeys.points_bonus`
         * over completed enrollments, so stamping `completed_at` above IS the
         * award. That is what keeps one formula (§10.5).
         */
        await this.certificates.issueForJourney(scope, userId, journeyId);
        await this.badges.award(scope, userId, journeyBadgeKey(journeyId), journeyId);
        // Re-evaluates the whole catalogue, which is what picks up the
        // journey_first / journey_three / journey_five milestones.
        await this.badges.syncForBestEffort(scope, userId);

        if (newlyCompleted) {
          this.logger.log(`Journey ${journeyId} completed by user=${userId}`);
        }
      }
    } catch (error) {
      this.logger.warn(
        `onCourseProgress best-effort failure for user=${userId} course=${courseId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
