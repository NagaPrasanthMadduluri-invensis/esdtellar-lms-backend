import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { ScormService } from '../scorm/scorm.service';
import { MediaService } from '@/modules/media/media.service';

import { CoursesRepository } from './courses.repository';
import type {
  CourseDto,
  BulkAssignmentDto,
  CreateAssignmentDto,
  CreateLessonDto,
  CreateResourceDto,
  ModuleDto,
  UpdateLessonDto,
} from './dto/course.dto';

/**
 * Content types that ARE a document. `document` is what the lesson form writes
 * now; the rest are older values still in the data, and they behave the same —
 * no runtime of their own, so their duration is typed rather than measured.
 */
const DOCUMENT_TYPES = new Set(['document', 'pdf', 'ppt', 'doc', 'xls']);

function isDocumentType(contentType: string): boolean {
  return DOCUMENT_TYPES.has((contentType || '').toLowerCase());
}

@Injectable()
export class CoursesService {
  constructor(
    private readonly repository: CoursesRepository,
    private readonly media: MediaService,
    private readonly scorm: ScormService,
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
  private assertLessonContent(lesson: {
    contentType: string;
    contentUrl: string | null;
    documentKey: string | null;
    scormPackageId: number | null;
    durationMinutes: number | null;
  }): void {
    const { contentType, contentUrl, documentKey, durationMinutes } = lesson;
    const isScorm = contentType === 'scorm';
    const isDocument = isDocumentType(contentType);

    if (isDocument && !documentKey && !contentUrl) {
      throw new UnprocessableEntityException(
        'Upload a document or provide a link to one.',
      );
    }

    if (isScorm && !lesson.scormPackageId) {
      throw new UnprocessableEntityException(
        'A SCORM lesson needs an uploaded package.',
      );
    }

    if ((isDocument || isScorm) && !(Number(durationMinutes) > 0)) {
      throw new UnprocessableEntityException(
        isDocument
          ? 'Enter how long this document takes, in minutes. It has no runtime ' +
            'to read, and this is the time it contributes to learning hours.'
          : 'This package does not declare how long it takes, so enter the ' +
            'duration in minutes.',
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
  private assertNotSessionTraining(sessionId: number | null): void {
    if (sessionId) {
      throw new UnprocessableEntityException(
        'This is a live session\'s training and is managed from Sessions. ' +
          'Edit or delete the session itself to change it.',
      );
    }
  }

  /* ── Courses ── */

  async list(scope: OrgScope) {
    const rows = (await this.repository.listWithStats(scope)) as Record<
      string,
      unknown
    >[];

    return {
      courses: rows.map((row) => {
        const enrolled = Number(row.enrollments_count);
        const completedEnrollments = Number(row.completed_enrollments);
        const lessonsCount = Number(row.lessons_count);

        return {
          ...row,
          is_active: Number(row.is_active) === 1,
          avg_score:
            row.avg_score !== null && row.avg_score !== undefined
              ? Math.round(Number(row.avg_score))
              : null,
          completion_pct:
            enrolled > 0 && lessonsCount > 0
              ? Math.round((completedEnrollments / enrolled) * 100)
              : 0,
        };
      }),
    };
  }

  async get(scope: OrgScope, courseId: number) {
    const course = await this.repository.findById(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    return { course };
  }

  /** Content: takes the OWNER's org — `scope.organizationId` for the admin creating it. */
  async create(scope: OrgScope, dto: CourseDto) {
    const course = await this.repository.createCourse({
      organizationId: scope.organizationId,
      name: dto.name,
      description: dto.description ?? null,
      thumbnailUrl: dto.thumbnail_url ?? null,
      // `is_active` is optional, and `Boolean(undefined)` is false — so a
      // course created without the flag used to be born hidden, contradicting
      // the column's own DEFAULT 1. Omitted now means active.
      isActive: dto.is_active ?? true,
    });
    return { course };
  }

  async update(scope: OrgScope, courseId: number, dto: CourseDto) {
    const existing = await this.repository.findById(scope, courseId);
    if (!existing) throw new NotFoundException('Course not found');
    this.assertNotSessionTraining(existing.sessionId);

    const course = await this.repository.updateCourse(scope, courseId, {
      name: dto.name,
      description: dto.description ?? null,
      thumbnailUrl: dto.thumbnail_url ?? null,
      // Omitted means "leave it alone". Renaming a course must not hide it
      // from every learner as a side effect.
      isActive: dto.is_active ?? existing.isActive === 1,
    });
    return { course };
  }

  async remove(scope: OrgScope, courseId: number) {
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForCourse(scope, courseId),
    );
    await this.repository.deleteCourse(scope, courseId);
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

  async createLesson(scope: OrgScope, moduleId: number, dto: CreateLessonDto) {
    // Existence AND ownership in one read — a foreign module id must 404
    // rather than let a cross-org lesson get created against it (§5.3).
    const module = await this.repository.findModuleById(scope, moduleId);
    if (!module) throw new NotFoundException('Module not found');
    this.assertNotSessionTraining(
      await this.repository.findSessionIdForModule(scope, moduleId),
    );

    const contentType = dto.content_type || 'video';
    const isScorm = contentType === 'scorm';
    const isDocument = isDocumentType(contentType);
    const sortOrder =
      dto.sort_order ??
      (await this.repository.nextLessonSortOrder(scope, moduleId));

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
    const isDocument = isDocumentType(contentType);

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
