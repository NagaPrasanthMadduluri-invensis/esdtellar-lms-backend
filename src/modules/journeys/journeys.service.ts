import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { MediaService } from '@/modules/media/media.service';
import { contentTypeOf } from '@/modules/learner/learner.constants';
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

/**
 * What a STEP is doing, as distinct from whether the learner may open it.
 *
 * `stepStatus` answers the gate — locked, open, complete — and that is what
 * enforcement reads. It deliberately cannot tell "not touched" from "half
 * finished", because the gate does not care. A card does: offering Start to
 * somebody 60% of the way through a course is the screen that lies, in
 * miniature.
 *
 * `failed` is only claimed when an assessment was actually attempted and not
 * passed. A course whose lessons are all done but whose quiz is still
 * outstanding is IN PROGRESS, not failed — the completion definition
 * (§10.11) already requires the pass, and calling that a failure would
 * accuse somebody of something they have not done yet.
 */
function stepProgressStatus(step: {
  isComplete: boolean;
  lessonsDone: number;
  hasPassed: boolean | null;
}): 'complete' | 'failed' | 'in_progress' | 'not_started' {
  if (step.isComplete) return 'complete';
  if (step.hasPassed === false) return 'failed';
  return step.lessonsDone > 0 ? 'in_progress' : 'not_started';
}

/** Split a comma-joined free-text column into clean, non-empty parts. */
function csv(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The skills a learner has EARNED on a path — the tags of the courses they
 * have actually completed, de-duplicated in first-seen order.
 *
 * Distinct from `journeys.skills`, which is what the path is ABOUT and is
 * true from the first second. This is what the learner has picked up SO FAR,
 * and it is the only one of the two that moves: a row of ticks on a path
 * card that never changes until the path is finished is furniture, and a
 * learner comparing two paths in progress is choosing between the one where
 * more of this list is ticked. Empty until something is completed, which is
 * the honest answer rather than a fallback to the path's own tag list.
 */
function earnedSkills(
  steps: { isComplete: boolean; courseTags: string | null }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of steps) {
    if (!step.isComplete) continue;
    for (const tag of csv(step.courseTags)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/** The compact shape a list card's chip needs — nothing more. */
function shapeStep(row: {
  course_id: number;
  course_name: string;
  sort_order: number;
  is_required: number;
  is_complete: boolean;
  lessons_done: number;
  has_passed: number | null;
  content_types: string | null;
  course_tags: string | null;
}) {
  return {
    course_id: Number(row.course_id),
    course_name: row.course_name,
    sort_order: Number(row.sort_order),
    is_required: Number(row.is_required) === 1,
    // The SAME derivation the detail view uses, so a chip and the step card
    // it links to can never disagree about whether something was started.
    progress_status: stepProgressStatus({
      isComplete: Boolean(row.is_complete),
      lessonsDone: Number(row.lessons_done ?? 0),
      hasPassed: row.has_passed === null ? null : Number(row.has_passed) === 1,
    }),
    /* What the step is made of, and what it is tagged with. Both are the
       course's, read once here so the chip and the step row do not each
       derive them. `contentTypeOf` is the reducer the learner course cards
       already use, so a path step and a course card cannot disagree about
       what kind of content a course is. */
    content_type: contentTypeOf(csv(row.content_types)),
    tags: csv(row.course_tags),
  };
}

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

    /* A STEP HAS TO BE COMPLETABLE BY WALKING THE PATH, and two kinds of
       course are not. A session's companion training is completed by
       attendance (§10.7), which needs a `session_roster` row that only
       `addToRoster` writes — a journey inserts the assignment directly, so
       a learner put on this path who is not separately booked onto the
       session has a step they can never finish, and therefore a path that
       can never complete. An external certification is already finished the
       moment it is approved (§10.26); there is nothing to do.
       Neither is offered by the admin Course Library the picker reads, so
       this refusal only closes the gap between what the UI shows and what
       the API accepted — §10.3.1.9 states the same rule for Assign
       Learning. The message names them, because the way out is to drop
       those steps. */
    const undeliverable = await this.repository.undeliverableCourses(scope, courseIds);
    if (undeliverable.length > 0) {
      const named = undeliverable
        .map((c) => `"${c.name}" (${c.reason})`)
        .join('; ');
      throw new UnprocessableEntityException(
        `A learning path cannot contain ${named}. Remove ${undeliverable.length === 1 ? 'it' : 'them'} and save again.`,
      );
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

    /* The chip sequence every card shows, for every card, in ONE query —
       the ordered courses are what makes a path a path rather than a
       bundle, so they belong on the card and not only behind a click.
       Grouped here rather than fetched per card (§7.1). */
    const steps = await this.repository.compactStepsForJourneys(
      scope,
      userId,
      rows.map((r) => Number(r.journey_id)),
    );
    const stepsByJourney = new Map<number, ReturnType<typeof shapeStep>[]>();
    /* Raw rows per journey, kept so `earnedSkills` is computed over the
       WHOLE sequence in one call — deriving it per row would keep only the
       last step's tags. */
    const rawByJourney = new Map<
      number,
      { isComplete: boolean; courseTags: string | null }[]
    >();
    for (const row of steps) {
      const key = Number(row.journey_id);
      const list = stepsByJourney.get(key);
      if (list) list.push(shapeStep(row));
      else stepsByJourney.set(key, [shapeStep(row)]);
      const raw = rawByJourney.get(key);
      const entry = { isComplete: Boolean(row.is_complete), courseTags: row.course_tags };
      if (raw) raw.push(entry);
      else rawByJourney.set(key, [entry]);
    }
    const earnedByJourney = new Map<number, string[]>();
    for (const [key, list] of rawByJourney) {
      earnedByJourney.set(key, earnedSkills(list));
    }

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
          /* What the learner has EARNED so far, as opposed to `skills`
             above, which is what the path is about. Different questions, and
             only this one moves while the path is in progress. */
          earned_skills: earnedByJourney.get(Number(row.journey_id)) ?? [],
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
          /* The card's three counts and its total length. Every course in
             the path, not only the required ones progress is measured
             against — a card saying "5 courses" over six chips would be
             two numbers disagreeing on one card. */
          course_count: Number(row.course_count ?? 0),
          completed_count: Number(row.completed_count ?? 0),
          in_progress_count: Number(row.in_progress_count ?? 0),
          not_started_count: Math.max(
            0,
            Number(row.course_count ?? 0) -
              Number(row.completed_count ?? 0) -
              Number(row.in_progress_count ?? 0),
          ),
          total_minutes: Number(row.total_minutes ?? 0),
          courses: stepsByJourney.get(Number(row.journey_id)) ?? [],
          /* "All required" is only worth saying when it is TRUE — a pill on
             every card claiming something that varies is noise. */
          all_required: (stepsByJourney.get(Number(row.journey_id)) ?? []).every(
            (c) => c.is_required,
          ),
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
        /* From the ENROLMENT, not the journey: when THIS learner was put on
           it and when THEY have to finish. The list card already showed
           both, and a detail view that drops them reads as though the dates
           had been withdrawn. */
        assigned_at: enrollment.assignedAt,
        due_date: enrollment.dueDate,
        completed_at: enrollment.completedAt,
        course_count: steps.length,
        completed_count: steps.filter((s) => s.isComplete).length,
        in_progress_count: steps.filter(
          (s) => !s.isComplete && s.lessonsDone > 0,
        ).length,
        not_started_count: steps.filter(
          (s) => !s.isComplete && s.lessonsDone === 0,
        ).length,
        total_minutes: steps.reduce((sum, s) => sum + s.durationMinutes, 0),
        /* The detail view's tick row, derived from the same step objects the
           sequence below is built from — so the skills ticked here and the
           steps ticked below cannot disagree. */
        earned_skills: earnedSkills(
          steps.map((s) => ({ isComplete: s.isComplete, courseTags: s.courseTags })),
        ),
        courses: steps.map((step, index) => ({
          course_id: step.courseId,
          course_name: step.courseName,
          thumbnail_url: step.thumbnailUrl,
          /* What the course is MADE OF, for the step row's icon. Reduced
             here from the course's lessons by the same `contentTypeOf` the
             learner course cards use. */
          content_type: contentTypeOf(csv(step.contentTypes)),
          sort_order: step.sortOrder,
          is_required: step.isRequired,
          /* The GATE — locked / open / complete. Unchanged, and still what
             decides whether the learner may open this step. */
          status: this.stepStatus(steps, index, journeyId),
          /* What the step is DOING, which the gate does not say: `open`
             covers both "not touched" and "half finished", and a card that
             cannot tell them apart offers Start to somebody who is 60% of
             the way through. Kept as a second field rather than folded into
             the first, because the gate is enforcement and this is only
             description — merging them would invite a caller to gate on a
             progress figure. */
          progress_status: stepProgressStatus(step),
          duration_minutes: step.durationMinutes,
          lessons_total: step.lessonsTotal,
          lessons_done: step.lessonsDone,
          percent:
            step.lessonsTotal > 0
              ? Math.min(
                  100,
                  Math.round((step.lessonsDone / step.lessonsTotal) * 100),
                )
              : 0,
          score: step.bestScore,
          has_passed: step.hasPassed,
          due_date: step.dueDate,
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
