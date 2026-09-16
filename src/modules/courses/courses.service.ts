import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { ScormService } from '../scorm/scorm.service';
import { ActivityService } from '@/modules/activity/activity.service';
import { COMPLIANCE_CATEGORY, isMandatory } from '@/common/course-taxonomy';
import {
  contentTypeOf,
  durationRequiredFor,
  isDocumentLike,
} from '@/common/lesson-content';

/** Below this, a course with enrolments is flagged as needing attention. */
const LOW_COMPLETION_PCT = 40;
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { MediaService } from '@/modules/media/media.service';

import { CoursesRepository } from './courses.repository';
import type {
  BulkCourseActionDto,
  CourseDto,
  BulkAssignmentDto,
  CreateAssignmentDto,
  CreateLessonDto,
  CreateResourceDto,
  ModuleDto,
  UpdateLessonDto,
} from './dto/course.dto';

/**
 * Document-likeness and the duration rule now live in
 * `common/lesson-content.ts`, beside the rest of the type catalogue — the
 * local copy predated it and had drifted (it knew `doc`/`xls` but not `word`
 * or `image`, so an image lesson was not required to declare a duration and
 * was silently worth zero learning hours).
 */

@Injectable()
export class CoursesService {
  constructor(
    private readonly repository: CoursesRepository,
    private readonly media: MediaService,
    private readonly scorm: ScormService,
    /** Best-effort (§8.4) — never wrapped, `record` cannot throw. */
    private readonly activity: ActivityService,
  ) {}

  /* ── Lesson content rules ── */

  /**
   * What a lesson must carry to be saveable.
   *
   * Two rules, both of which used to be enforced only in the browser — so an
   * admin could save a document lesson with no document, or one with no
   * duration, and the gap only surfaced later as a learner staring at an empty
   * page or a course whose hours did not add up.
   *
   * **Content.** A document lesson needs an uploaded file OR an external link
   * — the two options are equivalent, but one of them has to be there. SCORM
   * needs a package.
   *
   * **Duration.** Required for documents and SCORM, and only for those:
   *
   *   - A document has no runtime to read, so the number can only come from the
   *     admin. It is also the number learning hours credits on completion
   *     (§10.4), so leaving it null would silently make the lesson worth zero.
   *   - SCORM is auto-filled from the manifest's typicalLearningTime when the
   *     package declares one; when it does not, the admin has to supply it, and
   *     this is what makes that non-optional.
   *   - Video is exempt on purpose: the length is read from the file after the
   *     row exists (the key is namespaced by lesson id), so at create time a
   *     perfectly valid video lesson has no duration yet. For a video given as
   *     a URL there is nothing to read either, and a wrong required-field error
   *     would be worse than an absent stated length — the hours come from
   *     measured watch time regardless.
   */
  /**
   * The one place both lesson rules live, run on create and on update against
   * the MERGED state, so a partial edit cannot leave a lesson invalid (§10.8).
   *
   * Driven by `common/lesson-content.ts` rather than a chain of `if`s here:
   * each type declares whether it can be uploaded and whether it must state a
   * duration, so adding a type is one entry there and no change in this file.
   */
  private assertLessonContent(lesson: {
    contentType: string;
    contentUrl: string | null;
    documentKey: string | null;
    videoKey?: string | null;
    scormPackageId: number | null;
    durationMinutes: number | null;
  }): void {
    const { contentType, contentUrl, documentKey, durationMinutes } = lesson;
    const type = contentTypeOf(contentType);

    if (contentType === 'scorm') {
      if (!lesson.scormPackageId) {
        throw new UnprocessableEntityException(
          'A SCORM lesson needs an uploaded package.',
        );
      }
    } else if (contentType === 'link') {
      // Link-only: there is nothing to upload, so a URL is the whole content.
      if (!contentUrl) {
        throw new UnprocessableEntityException(
          'Enter the URL this lesson links to.',
        );
      }
    } else if (contentType === 'video') {
      if (!lesson.videoKey && !contentUrl) {
        throw new UnprocessableEntityException(
          'Upload a video or provide a link to one.',
        );
      }
    } else if (isDocumentLike(contentType)) {
      if (!documentKey && !contentUrl) {
        throw new UnprocessableEntityException(
          `Upload ${type ? `a ${type.label.toLowerCase()}` : 'a file'} or provide a link to one.`,
        );
      }
    }

    // Duration. Everything except video must declare one: nothing else has a
    // runtime to measure, and a null is worth zero learning hours (§10.4),
    // which is a lesson that silently pays nothing.
    if (durationRequiredFor(contentType) && !(Number(durationMinutes) > 0)) {
      throw new UnprocessableEntityException(
        contentType === 'scorm'
          ? 'This package does not declare how long it takes, so enter the ' +
            'duration in minutes.'
          : 'Enter how long this lesson takes, in minutes. It has no runtime ' +
            'to measure, and this is the time it contributes to learning hours.',
      );
    }
  }


  /* ── Lesson resources ───────────────────────────────────────────────────
     Supporting material alongside a lesson's primary content: the slide deck
     for a live session, a handout beside a video, a link to a spec.

     Deliberately without a duration. A resource is reference material, not
     something to complete, so it never reaches learning hours — which keeps
     exactly one number per lesson counting, the point of §10.4.
  ────────────────────────────────────────────────────────────────────────── */

  async listResources(scope: OrgScope, lessonId: number) {
    const lesson = await this.repository.findLessonById(scope, lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    return { resources: await this.repository.listResources(scope, lessonId) };
  }

  async createResource(scope: OrgScope, lessonId: number, dto: CreateResourceDto) {
    const lesson = await this.repository.findLessonById(scope, lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const isUpload = dto.source === 'upload';

    // `source` says which half of the row is live, so the other half must
    // actually be there. A row with neither points at nothing.
    if (isUpload && !dto.file_key) {
      throw new UnprocessableEntityException(
        'An uploaded resource needs its uploaded file.',
      );
    }
    if (!isUpload && !dto.url) {
      throw new UnprocessableEntityException('A linked resource needs a URL.');
    }

    const verified = isUpload
      ? await this.media.verifyUploadedDocument(dto.file_key as string)
      : null;

    // Content: the owning lesson's org, which is `scope` here.
    const resource = await this.repository.createResource({
      organizationId: scope.organizationId,
      lessonId,
      title: dto.title,
      resourceType:
        dto.resource_type ??
        (isUpload ? this.media.resourceTypeForMime(dto.mime_type) : 'link'),
      source: dto.source,
      fileKey: isUpload ? (dto.file_key as string) : null,
      fileName: isUpload ? (dto.file_name ?? null) : null,
      fileSizeBytes: verified?.sizeBytes ?? null,
      mimeType: isUpload ? (dto.mime_type ?? verified?.contentType ?? null) : null,
      url: isUpload ? null : (dto.url as string),
      sortOrder:
        dto.sort_order ??
        (await this.repository.nextResourceSortOrder(scope, lessonId)),
    });

    return { resource };
  }

  async removeResource(scope: OrgScope, resourceId: number) {
    const resource = await this.repository.findResourceById(scope, resourceId);
    if (!resource) throw new NotFoundException('Resource not found');

    this.assertNotSessionTraining(
      await this.repository.findSessionIdForLesson(scope, resource.lessonId),
    );

    await this.repository.deleteResource(scope, resourceId);
    // After the row, so nothing can leave a live row pointing at a dead object.
    await this.media.discardObject(resource.fileKey);

    return { message: 'Resource deleted' };
  }

  /* ── Session trainings ── */

  /**
   * A live session's companion course is generated from the session and kept in
   * step with it, so the course editor must not be a second way to change it.
   *
   * Renaming or deactivating it here would be silently overwritten the next
   * time the session is saved; deleting it, or its module or lesson, would
   * leave the session with a roster and nothing to credit. Adding a second
   * lesson is just as bad: marking the session completed would then leave the
   * training short of 100%, and the completion metrics would disagree with the
   * session for good. All of it is managed from Sessions instead.
   */
  /**
   * Refuses a write to platform-owned (global) content with 422.
   *
   * Reads are widened to `IN (org, platform)` so an org admin can SEE and
   * assign a global course — but editing one would be overwritten by the
   * platform admin and would change what every other organization sees. Same
   * shape as the session-training refusal below, and deliberately 422 rather
   * than 404: the item is legitimately visible, so pretending it does not
   * exist would be more confusing than saying it is not yours to edit
   * (spec §3.4).
   */
  private assertNotGlobalContent(
    scope: OrgScope,
    organizationId: number,
    what = 'content',
  ): void {
    if (organizationId !== scope.organizationId) {
      throw new UnprocessableEntityException(
        `This ${what} is published by the platform administrator and cannot be edited here.`,
      );
    }
  }

  private assertNotSessionTraining(sessionId: number | null): void {
    if (sessionId) {
      throw new UnprocessableEntityException(
        'This is a live session\'s training and is managed from Sessions. ' +
          'Edit or delete the session itself to change it.',
      );
    }
  }

  /* ── Courses ── */

  /**
   * The Course Library list, plus the KPI tiles above it.
   *
   * `archived: true` swaps to the archive; the two are never mixed (see
   * `listWithStats`). The stats are reduced from the rows already fetched
   * rather than counted again in SQL, so the tiles and the grid beneath them
   * cannot disagree — the same reason the Manage Users tiles work that way.
   */
  async list(scope: OrgScope, archived = false) {
    const [rawRows, archivedCount] = await Promise.all([
      this.repository.listWithStats(scope, archived) as Promise<
        Record<string, unknown>[]
      >,
      this.repository.archivedCount(scope),
    ]);

    const courses = rawRows.map((row) => {
      const enrolled = Number(row.enrollments_count);
      const completedEnrollments = Number(row.completed_enrollments);
      const lessonsCount = Number(row.lessons_count);
      const completionPct =
        enrolled > 0 && lessonsCount > 0
          ? Math.round((completedEnrollments / enrolled) * 100)
          : 0;

      return {
        ...row,
        // Restated as numbers rather than left to the spread: `row` is
        // Record<string, unknown>, so anything read off it downstream is
        // `unknown` and every reduce below would need a cast.
        enrollments_count: enrolled,
        lessons_count: lessonsCount,
        assessments_count: Number(row.assessments_count ?? 0),
        is_active: Number(row.is_active) === 1,
        is_mandatory: Number(row.is_mandatory ?? 0) === 1,
        mandatory: isMandatory({
          isMandatory: Number(row.is_mandatory ?? 0),
          category: (row.category as string | null) ?? null,
        }),
        avg_score:
          row.avg_score !== null && row.avg_score !== undefined
            ? Math.round(Number(row.avg_score))
            : null,
        completion_pct: completionPct,
        // Completed / in progress / not started, for the card's segmented bar.
        // Derived here rather than in the browser so the three always sum to
        // the enrolment count the card prints beside them.
        completed_count: completedEnrollments,
        in_progress_count: Number(row.in_progress_enrollments ?? 0),
        not_started_count: Math.max(
          0,
          enrolled - completedEnrollments - Number(row.in_progress_enrollments ?? 0),
        ),
        /**
         * Worth an admin's attention: nothing to assess, or nobody finishing.
         *
         * A COUNT of these is the reference's "Red Flags" tile. It is a
         * prompt, not a verdict — a course published yesterday is legitimately
         * at 0%, which is why the tile is labelled "need attention" rather
         * than something accusatory.
         */
        needs_attention:
          Number(row.assessments_count) === 0 ||
          (enrolled > 0 && completionPct < LOW_COMPLETION_PCT),
      };
    });

    const scored = courses.filter((c) => (c.avg_score ?? 0) > 0);

    return {
      courses,
      archived_count: archivedCount,
      stats: {
        total: courses.length,
        published: courses.filter((c) => c.is_active).length,
        draft: courses.filter((c) => !c.is_active).length,
        enrolled: courses.reduce((a, c) => a + c.enrollments_count, 0),
        avg_completion: courses.length
          ? Math.round(
              courses.reduce((a, c) => a + c.completion_pct, 0) / courses.length,
            )
          : 0,
        avg_score: scored.length
          ? Math.round(
              scored.reduce((a, c) => a + (c.avg_score ?? 0), 0) / scored.length,
            )
          : 0,
        mandatory: courses.filter((c) => c.mandatory).length,
        needs_attention: courses.filter((c) => c.needs_attention).length,
      },
    };
  }

  /**
   * Archive, restore, publish or unpublish any number of courses at once.
   *
   * One statement per action rather than a loop of single updates (§7.1), and
   * the repository's predicates are what refuse a session training or another
   * tenant's course — so a request naming twenty ids of which three are not
   * the caller's simply affects seventeen, and says so.
   */
  async bulk(scope: OrgScope, dto: BulkCourseActionDto, actor?: AuthenticatedUser) {
    const ids = dto.course_ids;
    const affected =
      dto.action === 'archive'
        ? await this.repository.setArchived(scope, ids, true)
        : dto.action === 'restore'
          ? await this.repository.setArchived(scope, ids, false)
          : await this.repository.setPublished(scope, ids, dto.action === 'publish');

    await this.activity.record(scope, {
      type: dto.action === 'publish' ? 'course_published' : 'course_updated',
      title:
        dto.action === 'archive' ? 'Courses archived'
        : dto.action === 'restore' ? 'Courses restored'
        : dto.action === 'publish' ? 'Courses published'
        : 'Courses unpublished',
      detail: `${affected} course${affected === 1 ? '' : 's'}`,
      actor: actor ?? null,
      subjectType: 'course',
      subjectId: ids.length === 1 ? ids[0] : null,
    });

    return { action: dto.action, affected, requested: ids.length };
  }

  /**
   * One course, in the same vocabulary the list uses.
   *
   * The list is raw SQL and speaks `thumbnail_url` / `is_active`; `findById`
   * is a Drizzle select and speaks `thumbnailUrl` / `isActive`. Handing the
   * second straight to the client made `/admin/courses/:id` a different shape
   * from `/admin/courses`, and the page reading it saw `undefined` for every
   * field it named the list's way — a published course rendered as a draft,
   * and its edit dialog then SAVED that back, so renaming a course quietly
   * unpublished it. Shaping here is also what §3.1 asks for: a controller
   * never sees a database row.
   */
  private shape(course: {
    id: number;
    organizationId: number;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    isActive: number;
    sessionId: number | null;
    category?: string | null;
    isMandatory?: number | null;
    expiryMonths?: number | null;
    tags?: string | null;
    archivedAt?: string | null;
    createdAt: unknown;
    updatedAt: unknown;
  }) {
    return {
      id: course.id,
      organization_id: course.organizationId,
      name: course.name,
      description: course.description,
      thumbnail_url: course.thumbnailUrl,
      is_active: Number(course.isActive) === 1,
      session_id: course.sessionId,
      category: course.category ?? null,
      // The STORED flag, so an edit dialog round-trips what the admin ticked.
      is_mandatory: Number(course.isMandatory ?? 0) === 1,
      // The DERIVED one, which is what a card ribbon or a count should read:
      // compliance is mandatory whether or not the box was ticked.
      mandatory: isMandatory({
        isMandatory: course.isMandatory ?? 0,
        category: course.category ?? null,
      }),
      expiry_months: course.expiryMonths ?? null,
      tags: course.tags ?? null,
      archived_at: course.archivedAt ?? null,
      created_at: course.createdAt,
      updated_at: course.updatedAt,
    };
  }

  async get(scope: OrgScope, courseId: number) {
    const course = await this.repository.findById(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    return {
      course: {
        ...this.shape(course),
        enrolled_count: await this.repository.enrolledCount(scope, courseId),
      },
    };
  }

  /** Content: takes the OWNER's org — `scope.organizationId` for the admin creating it. */
  async create(scope: OrgScope, dto: CourseDto, actor?: AuthenticatedUser) {
    const course = await this.repository.createCourse({
      organizationId: scope.organizationId,
      name: dto.name,
      description: dto.description ?? null,
      thumbnailUrl: dto.thumbnail_url
        ? this.media.assertCourseThumbnail(dto.thumbnail_url)
        : null,
      // `is_active` is optional, and `Boolean(undefined)` is false — so a
      // course created without the flag used to be born hidden, contradicting
      // the column's own DEFAULT 1. Omitted now means active.
      isActive: dto.is_active ?? true,
      category: dto.category ?? null,
      isMandatory: dto.is_mandatory ?? false,
      // A renewal cadence outside Compliance is meaningless, so it is dropped
      // rather than stored — otherwise a course could be filed under
      // Technical and still print "Renews every 12 mo" on its card.
      expiryMonths: dto.category === COMPLIANCE_CATEGORY ? (dto.expiry_months ?? null) : null,
      tags: dto.tags ?? null,
    });

    await this.activity.record(scope, {
      type: dto.is_active === false ? 'course_created' : 'course_published',
      detail: `${dto.is_active === false ? 'Created' : 'Published'} "${dto.name}"`,
      actor: actor ?? null,
      subjectType: 'course',
      subjectId: course.id,
    });

    return { course: this.shape(course) };
  }

  async update(scope: OrgScope, courseId: number, dto: CourseDto) {
    const existing = await this.repository.findById(scope, courseId);
    if (!existing) throw new NotFoundException('Course not found');
    this.assertNotGlobalContent(scope, existing.organizationId, 'course');
    this.assertNotSessionTraining(existing.sessionId);

    /**
     * Omitted means "leave it alone" — for the picture as much as for the
     * flag below it. The settings form sends name, description and the
     * publish switch; before this, that patch also blanked the thumbnail,
     * so an admin lost the course's picture by renaming it.
     *
     * An explicit null is a removal, and only then is the stored file dropped.
     */
    const thumbnailUrl =
      dto.thumbnail_url === undefined
        ? existing.thumbnailUrl
        : dto.thumbnail_url === null
          ? null
          : this.media.assertCourseThumbnail(dto.thumbnail_url);

    const course = await this.repository.updateCourse(scope, courseId, {
      name: dto.name,
      description: dto.description ?? null,
      thumbnailUrl,
      // Omitted means "leave it alone". Renaming a course must not hide it
      // from every learner as a side effect.
      isActive: dto.is_active ?? existing.isActive === 1,
      // Same rule for all four new fields: the settings form does not send
      // them, and a partial patch must not clear a course's category.
      category: dto.category === undefined ? existing.category : dto.category,
      isMandatory:
        dto.is_mandatory === undefined
          ? existing.isMandatory === 1
          : dto.is_mandatory,
      expiryMonths: nextExpiryMonths(dto, existing),
      tags: dto.tags === undefined ? existing.tags : dto.tags,
    });

    // Only once the row is written, and only for the picture it no longer
    // points at (§8.4 — a failed delete must not fail the edit).
    if (existing.thumbnailUrl && existing.thumbnailUrl !== thumbnailUrl) {
      await this.media.discardCourseThumbnail(existing.thumbnailUrl);
    }

    return { course: this.shape(course) };
  }

  async remove(scope: OrgScope, courseId: number) {
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForCourse(scope, courseId),
    );
    // Read before the delete — once the row is gone nothing records which
    // file was its picture.
    const existing = await this.repository.findById(scope, courseId);
    await this.repository.deleteCourse(scope, courseId);
    await this.media.discardCourseThumbnail(existing?.thumbnailUrl);
    return { message: 'Course deleted' };
  }

  /* ── Modules ── */

  /**
   * Modules with their lessons nested. Two queries total — the modules and all
   * their lessons — then grouped in memory.
   */
  async listModules(scope: OrgScope, courseId: number) {
    const [modules, allLessons] = await Promise.all([
      this.repository.listModules(scope, courseId),
      this.repository.listLessonsForCourse(scope, courseId),
    ]);

    const lessonsByModule = new Map<number, unknown[]>();
    for (const lesson of allLessons) {
      const key = Number(lesson.module_id);
      const list = lessonsByModule.get(key);
      if (list) list.push(lesson);
      else lessonsByModule.set(key, [lesson]);
    }

    return {
      modules: modules.map((module) => ({
        ...module,
        lessons: lessonsByModule.get(Number(module.id)) ?? [],
      })),
    };
  }

  async createModule(scope: OrgScope, courseId: number, dto: ModuleDto) {
    // Existence AND ownership in one read — a foreign course id must 404
    // rather than let a cross-org module get created against it (§5.3).
    const course = await this.repository.findById(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    this.assertNotSessionTraining(course.sessionId);

    const sortOrder = await this.repository.nextModuleSortOrder(scope, courseId);
    const module = await this.repository.createModule({
      organizationId: scope.organizationId,
      courseId,
      title: dto.title,
      description: dto.description ?? null,
      sortOrder,
    });
    return { module };
  }

  async updateModule(scope: OrgScope, moduleId: number, dto: ModuleDto) {
    const current = await this.repository.findModuleById(scope, moduleId);
    if (!current) throw new NotFoundException('Module not found');
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForModule(scope, moduleId),
    );

    const module = await this.repository.updateModule(scope, moduleId, {
      title: dto.title,
      description: dto.description ?? null,
      isActive: dto.is_active ?? current.isActive === 1,
      sortOrder: dto.sort_order ?? current.sortOrder,
    });
    if (!module) throw new NotFoundException('Module not found');
    return { module };
  }

  async removeModule(scope: OrgScope, moduleId: number) {
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForModule(scope, moduleId),
    );
    await this.repository.deleteModule(scope, moduleId);
    return { message: 'Module deleted' };
  }

  /* ── Lessons ── */

  async listLessons(scope: OrgScope, moduleId: number) {
    const lessons = await this.repository.listLessonsByModule(scope, moduleId);
    return { lessons: await this.withResources(scope, lessons) };
  }

  /**
   * Attaches each lesson's supporting resources.
   *
   * One query for the whole page rather than one per lesson — the editor lists
   * every lesson in a module at once, and a query per row is the N+1 §7.1 exists
   * to stop.
   */
  private async withResources<T extends { id: number }>(
    scope: OrgScope,
    lessons: T[],
  ) {
    const rows = await this.repository.listResourcesForLessons(
      scope,
      lessons.map((lesson) => Number(lesson.id)),
    );

    const byLesson = new Map<number, typeof rows>();
    for (const row of rows) {
      const key = Number(row.lesson_id);
      const list = byLesson.get(key);
      if (list) list.push(row);
      else byLesson.set(key, [row]);
    }

    return lessons.map((lesson) => ({
      ...lesson,
      resources: byLesson.get(Number(lesson.id)) ?? [],
    }));
  }

  /**
   * Every lesson in a course — placed and staged — for the authoring page.
   */
  async listCourseLessons(scope: OrgScope, courseId: number) {
    const course = await this.repository.findById(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    const rows = await this.repository.listCourseLessons(scope, courseId);
    return {
      lessons: rows.map((r) => ({
        ...r,
        is_active: Number(r.is_active) === 1,
        is_preview: Number(r.is_preview) === 1,
        // The field the authoring UI actually branches on. Derived here so
        // the browser never has to know that "staged" means a null module.
        staged: r.module_id === null,
      })),
    };
  }

  /**
   * Move a lesson into a module, or back to staged (`moduleId: null`).
   *
   * UNLINKING IS NOT DELETING, and that distinction is the whole feature: the
   * lesson keeps its content, its resources and its attached assessment, and
   * stops being delivered until it is placed again.
   */
  async setLessonModule(
    scope: OrgScope,
    lessonId: number,
    moduleId: number | null,
  ) {
    const lesson = await this.repository.findLessonById(scope, lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForLesson(scope, lessonId),
    );

    let sortOrder: number;
    if (moduleId === null) {
      sortOrder = await this.repository.nextCourseLessonSortOrder(
        scope,
        lesson.courseId,
      );
    } else {
      const module = await this.repository.findModuleById(scope, moduleId);
      if (!module) throw new NotFoundException('Module not found');
      // Both belong to the same course, or the lesson would be in two places.
      if (module.courseId !== lesson.courseId) {
        throw new UnprocessableEntityException(
          'That module belongs to a different course.',
        );
      }
      sortOrder = await this.repository.nextLessonSortOrder(scope, moduleId);
    }

    const updated = await this.repository.setLessonModule(
      scope,
      lessonId,
      moduleId,
      sortOrder,
    );
    if (!updated) throw new NotFoundException('Lesson not found');
    return { lesson: { ...updated, staged: updated.moduleId === null } };
  }

  /**
   * Create a lesson INSIDE a module. The course is taken from the module, so
   * the two can never disagree.
   */
  async createLesson(scope: OrgScope, moduleId: number, dto: CreateLessonDto) {
    // Existence AND ownership in one read — a foreign module id must 404
    // rather than let a cross-org lesson get created against it (§5.3).
    const module = await this.repository.findModuleById(scope, moduleId);
    if (!module) throw new NotFoundException('Module not found');
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForModule(scope, moduleId),
    );
    return this.insertLesson(scope, module.courseId, moduleId, dto);
  }

  /**
   * Create a lesson at COURSE level, optionally already in a module.
   *
   * This is what the authoring flow uses: write the lesson, arrange it later.
   * A lesson with no module is STAGED — invisible to learners and counting for
   * nothing until it is linked (see migration 0020, which explains why that is
   * what keeps the rest of the system correct).
   */
  async createCourseLesson(
    scope: OrgScope,
    courseId: number,
    dto: CreateLessonDto,
  ) {
    const course = await this.repository.findById(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    this.assertNotGlobalContent(scope, course.organizationId, 'course');
    this.assertNotSessionTraining(course.sessionId);

    let moduleId: number | null = null;
    if (dto.module_id != null) {
      const module = await this.repository.findModuleById(scope, dto.module_id);
      if (!module) throw new NotFoundException('Module not found');
      // A module from another course would put the lesson in two places at
      // once — its own course_id and its module's.
      if (module.courseId !== courseId) {
        throw new UnprocessableEntityException(
          'That module belongs to a different course.',
        );
      }
      moduleId = module.id;
    }
    return this.insertLesson(scope, courseId, moduleId, dto);
  }

  /** Everything both create paths share. */
  private async insertLesson(
    scope: OrgScope,
    courseId: number,
    moduleId: number | null,
    dto: CreateLessonDto,
  ) {

    const contentType = dto.content_type || 'video';
    const isScorm = contentType === 'scorm';
    const isDocument = isDocumentLike(contentType);
    const sortOrder =
      dto.sort_order ??
      (moduleId === null
        // A staged lesson is ordered within the course's staging list, not
        // within a module it is not in.
        ? await this.repository.nextCourseLessonSortOrder(scope, courseId)
        : await this.repository.nextLessonSortOrder(scope, moduleId));

    const documentKey = isDocument ? (dto.document_key ?? null) : null;
    // Proven to exist in storage before the row records it: otherwise a failed
    // upload leaves the lesson pointing at nothing and the learner is the one
    // who finds out.
    const documentSize = documentKey
      ? (await this.media.verifyUploadedDocument(documentKey)).sizeBytes
      : null;

    this.assertLessonContent({
      contentType,
      contentUrl: dto.content_url ?? null,
      documentKey,
      scormPackageId: dto.scorm_package_id ?? null,
      durationMinutes: dto.duration_minutes ?? null,
    });

    // A SCORM package referenced from the body must belong to this
    // organization. `lessons.scorm_package_id` is a single-column FK, so the
    // database will happily accept another org's id (§3.5) — an admin who
    // cannot see a package could otherwise embed it by guessing, and its title
    // and version would surface through the learner-detail read (§3.4, §6.15).
    if (isScorm && dto.scorm_package_id != null) {
      await this.scorm.assertPackageInScope(scope, dto.scorm_package_id);
    }

    const lesson = await this.repository.createLesson({
      organizationId: scope.organizationId,
      courseId,
      moduleId,
      title: dto.title,
      description: dto.description ?? null,
      contentType,
      // A lesson is either a URL or a SCORM package, never both.
      contentUrl: isScorm ? null : (dto.content_url ?? null),
      scormPackageId: isScorm ? (dto.scorm_package_id ?? null) : null,
      documentKey,
      documentName: documentKey ? (dto.document_name ?? null) : null,
      documentMime: documentKey ? (dto.document_mime ?? null) : null,
      documentSizeBytes: documentSize,
      durationMinutes: dto.duration_minutes ?? null,
      sortOrder,
      isPreview: dto.is_preview ? 1 : 0,
      isActive: dto.is_active !== false ? 1 : 0,
    });

    /**
     * The lesson row exists, so the package it references is no longer
     * provisional. Claiming AFTER the write, never before: the whole point is
     * that a package uploaded by the lesson editor stays sweepable until a
     * lesson actually lands, and claiming it up front would recreate the
     * orphan problem migration 0010 exists to fix.
     */
    if (lesson.scormPackageId != null) {
      await this.scorm.claimPackage(scope, lesson.scormPackageId);
    }

    return { lesson };
  }

  async updateLesson(scope: OrgScope, lessonId: number, dto: UpdateLessonDto) {
    const current = await this.repository.findLessonById(scope, lessonId);
    if (!current) throw new NotFoundException('Lesson not found');
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForLesson(scope, lessonId),
    );

    const contentType = dto.content_type ?? current.contentType;
    const isScorm = contentType === 'scorm';
    const isDocument = isDocumentLike(contentType);

    const contentUrl = isScorm
      ? null
      : dto.content_url !== undefined
        ? dto.content_url
        : current.contentUrl;
    const durationMinutes =
      dto.duration_minutes !== undefined
        ? dto.duration_minutes
        : current.durationMinutes;

    // A lesson that is no longer a document keeps no document. Its object is
    // dropped below, once the row no longer names it.
    const requestedKey =
      dto.document_key !== undefined ? dto.document_key : current.documentKey;
    const documentKey = isDocument ? (requestedKey ?? null) : null;

    const replacedKey =
      current.documentKey && current.documentKey !== documentKey
        ? current.documentKey
        : null;

    let documentSize = current.documentSizeBytes;
    if (documentKey && documentKey !== current.documentKey) {
      documentSize = (await this.media.verifyUploadedDocument(documentKey))
        .sizeBytes;
    } else if (!documentKey) {
      documentSize = null;
    }

    this.assertLessonContent({
      contentType,
      contentUrl,
      documentKey,
      scormPackageId: isScorm
        ? (dto.scorm_package_id !== undefined
            ? dto.scorm_package_id
            : current.scormPackageId)
        : null,
      durationMinutes,
    });

    // Same guard as createLesson: an id arriving in the body is caller-supplied
    // and the single-column FK cannot reject a foreign org's package (§3.4).
    // Only checked when the request actually supplies one — an unchanged
    // lesson keeps a package that was already validated on the way in.
    if (isScorm && dto.scorm_package_id != null) {
      await this.scorm.assertPackageInScope(scope, dto.scorm_package_id);
    }

    const lesson = await this.repository.updateLesson(scope, lessonId, {
      title: dto.title ?? current.title,
      description:
        dto.description !== undefined ? dto.description : current.description,
      contentType,
      contentUrl,
      scormPackageId: isScorm
        ? dto.scorm_package_id !== undefined
          ? dto.scorm_package_id
          : current.scormPackageId
        : null,
      documentKey,
      documentName: documentKey
        ? (dto.document_name !== undefined
            ? dto.document_name
            : current.documentName)
        : null,
      documentMime: documentKey
        ? (dto.document_mime !== undefined
            ? dto.document_mime
            : current.documentMime)
        : null,
      documentSizeBytes: documentSize,
      durationMinutes,
      sortOrder: dto.sort_order !== undefined ? dto.sort_order : current.sortOrder,
      isPreview:
        dto.is_preview !== undefined
          ? dto.is_preview
            ? 1
            : 0
          : current.isPreview,
      isActive:
        dto.is_active !== undefined ? (dto.is_active ? 1 : 0) : current.isActive,
    });

    // Only after the row has stopped naming it. Best-effort (§8.4): an orphaned
    // object costs storage, a thrown error costs the admin their edit.
    await this.media.discardObject(replacedKey);

    /**
     * Same as createLesson: the row now references the package, so it stops
     * being provisional. Claiming after the write is what keeps an abandoned
     * lesson-editor upload sweepable (migration 0010).
     */
    if (lesson.scormPackageId != null) {
      await this.scorm.claimPackage(scope, lesson.scormPackageId);
    }

    return { lesson };
  }

  async removeLesson(scope: OrgScope, lessonId: number) {
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForLesson(scope, lessonId),
    );
    // Drop the R2 objects before the row that names them disappears —
    // afterwards there is nothing left to say which keys were this lesson's.
    // Best-effort: a storage hiccup must not block deleting the lesson (§8.4).
    await this.media.releaseLessonMedia(scope, lessonId);
    // Resources cascade with the row, but their stored objects do not — and
    // once the rows are gone nothing records which keys were theirs.
    const resources = await this.repository.listResourcesForKeys(scope, lessonId);
    await Promise.all(
      resources.map((r) => this.media.discardObject(r.file_key)),
    );
    await this.repository.deleteLesson(scope, lessonId);
    return { message: 'Lesson deleted' };
  }

  /* ── Assignments ── */

  async listAssignments(scope: OrgScope, courseId: number) {
    const [assignments, scormRows] = await Promise.all([
      this.repository.listAssignments(scope, courseId),
      this.repository.listScormResultsForCourse(scope, courseId),
    ]);

    const scormByUser = new Map<number, unknown[]>();
    for (const row of scormRows) {
      const key = Number(row.user_id);
      const list = scormByUser.get(key);
      if (list) list.push(row);
      else scormByUser.set(key, [row]);
    }

    return {
      assignments: assignments.map((assignment) => ({
        ...assignment,
        scorm_results: scormByUser.get(Number(assignment.user_id)) ?? [],
      })),
    };
  }

  /**
   * Bulk assign, in one statement.
   *
   * Returns how many were NEWLY created — learners already on the course are
   * skipped by the unique constraint — so the UI can report "assigned 7 of 12"
   * instead of implying it enrolled everyone it was handed.
   */
  async createAssignments(
    scope: OrgScope,
    courseId: number,
    dto: BulkAssignmentDto,
    adminId: number,
    actor?: AuthenticatedUser,
  ) {
    // A foreign course id must 404 rather than create activity rows that
    // point at another org's course under this org's organization_id (§5.3).
    if (!(await this.repository.findById(scope, courseId))) {
      throw new NotFoundException('Course not found');
    }

    // user_ids are caller-supplied; narrow them to this org so a foreign id
    // is a 404 rather than a constraint violation surfacing as a 500.
    const inScope = await this.repository.filterLearnersInOrg(
      scope,
      dto.user_ids,
    );
    if (inScope.length !== dto.user_ids.length) {
      throw new NotFoundException('One or more learners were not found');
    }

    const assigned = await this.repository.createAssignments({
      organizationId: scope.organizationId,
      userIds: inScope,
      courseId,
      assignedBy: adminId,
      dueDate: dto.due_date ?? null,
    });

    // ONE row for the whole action, never one per learner (§7.1 in spirit —
    // and the panel would otherwise be fifteen identical lines).
    await this.activity.record(scope, {
      type: 'learning_assigned',
      detail: `Assigned a course to ${assigned} learner${assigned === 1 ? '' : 's'}`,
      actor: actor ?? null,
      subjectType: 'course',
      subjectId: courseId,
    });

    return { assigned, requested: dto.user_ids.length };
  }

  /**
   * Assigning an already-assigned learner is not an error — it updates the due
   * date and reports "Assignment updated", which is what the assign-learning
   * screen expects when an admin re-submits.
   */
  async assign(
    scope: OrgScope,
    courseId: number,
    adminId: number,
    dto: CreateAssignmentDto,
  ) {
    // A foreign course id must 404 rather than create an activity row that
    // points at another org's course under this org's organization_id (§5.3).
    if (!(await this.repository.findById(scope, courseId))) {
      throw new NotFoundException('Course not found');
    }

    const learner = await this.repository.findLearner(scope, dto.user_id);
    if (!learner) throw new NotFoundException('Learner not found');

    const existing = await this.repository.findAssignment(
      scope,
      dto.user_id,
      courseId,
    );
    if (existing) {
      if (dto.due_date) {
        await this.repository.updateAssignmentDueDate(
          scope,
          dto.user_id,
          courseId,
          dto.due_date,
        );
      }
      return { created: false, body: { message: 'Assignment updated' } };
    }

    await this.repository.createAssignment({
      organizationId: scope.organizationId,
      userId: dto.user_id,
      courseId,
      assignedBy: adminId,
      dueDate: dto.due_date ?? null,
    });

    return { created: true, body: { message: 'User assigned successfully' } };
  }

  async removeAssignment(scope: OrgScope, assignmentId: number) {
    await this.repository.deleteAssignment(scope, assignmentId);
    return { message: 'Assignment removed' };
  }
}

/**
 * The renewal cadence a course should end up with after an edit.
 *
 * Three rules, in order, and the last one is why this is a function rather
 * than an inline `??` chain:
 *
 *   1. moved OUT of Compliance  -> cleared. A Technical course printing
 *      "Renews every 12 mo" is a lie the card would tell forever.
 *   2. field omitted            -> left alone (the settings form never sends it).
 *   3. field sent               -> taken, but only if the course is compliance.
 */
function nextExpiryMonths(
  dto: { category?: string | null; expiry_months?: number | null },
  existing: { category: string | null; expiryMonths: number | null },
): number | null {
  const category = dto.category === undefined ? existing.category : dto.category;
  if (category !== COMPLIANCE_CATEGORY) return null;
  return dto.expiry_months === undefined
    ? existing.expiryMonths
    : (dto.expiry_months ?? null);
}
