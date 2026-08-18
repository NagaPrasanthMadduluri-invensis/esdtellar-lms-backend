import { Injectable, NotFoundException } from '@nestjs/common';

import { MediaService } from '@/modules/media/media.service';

import { CoursesRepository } from './courses.repository';
import type {
  CourseDto,
  BulkAssignmentDto,
  CreateAssignmentDto,
  CreateLessonDto,
  ModuleDto,
  UpdateLessonDto,
} from './dto/course.dto';

@Injectable()
export class CoursesService {
  constructor(
    private readonly repository: CoursesRepository,
    private readonly media: MediaService,
  ) {}

  /* ── Courses ── */

  async list() {
    const rows = (await this.repository.listWithStats()) as Record<
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

  async get(courseId: number) {
    const course = await this.repository.findById(courseId);
    if (!course) throw new NotFoundException('Course not found');
    return { course };
  }

  async create(dto: CourseDto) {
    const course = await this.repository.createCourse({
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

  async update(courseId: number, dto: CourseDto) {
    const existing = await this.repository.findById(courseId);
    if (!existing) throw new NotFoundException('Course not found');

    const course = await this.repository.updateCourse(courseId, {
      name: dto.name,
      description: dto.description ?? null,
      thumbnailUrl: dto.thumbnail_url ?? null,
      // Omitted means "leave it alone". Renaming a course must not hide it
      // from every learner as a side effect.
      isActive: dto.is_active ?? existing.isActive === 1,
    });
    return { course };
  }

  async remove(courseId: number) {
    await this.repository.deleteCourse(courseId);
    return { message: 'Course deleted' };
  }

  /* ── Modules ── */

  /**
   * Modules with their lessons nested. Two queries total — the modules and all
   * their lessons — then grouped in memory.
   */
  async listModules(courseId: number) {
    const [modules, allLessons] = await Promise.all([
      this.repository.listModules(courseId),
      this.repository.listLessonsForCourse(courseId),
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

  async createModule(courseId: number, dto: ModuleDto) {
    const sortOrder = await this.repository.nextModuleSortOrder(courseId);
    const module = await this.repository.createModule({
      courseId,
      title: dto.title,
      description: dto.description ?? null,
      sortOrder,
    });
    return { module };
  }

  async updateModule(moduleId: number, dto: ModuleDto) {
    const current = await this.repository.findModuleById(moduleId);
    if (!current) throw new NotFoundException('Module not found');

    const module = await this.repository.updateModule(moduleId, {
      title: dto.title,
      description: dto.description ?? null,
      isActive: dto.is_active ?? current.isActive === 1,
    });
    if (!module) throw new NotFoundException('Module not found');
    return { module };
  }

  async removeModule(moduleId: number) {
    await this.repository.deleteModule(moduleId);
    return { message: 'Module deleted' };
  }

  /* ── Lessons ── */

  async listLessons(moduleId: number) {
    return { lessons: await this.repository.listLessonsByModule(moduleId) };
  }

  async createLesson(moduleId: number, dto: CreateLessonDto) {
    const contentType = dto.content_type || 'video';
    const isScorm = contentType === 'scorm';
    const sortOrder =
      dto.sort_order ?? (await this.repository.nextLessonSortOrder(moduleId));

    const lesson = await this.repository.createLesson({
      moduleId,
      title: dto.title,
      description: dto.description ?? null,
      contentType,
      // A lesson is either a URL or a SCORM package, never both.
      contentUrl: isScorm ? null : (dto.content_url ?? null),
      scormPackageId: isScorm ? (dto.scorm_package_id ?? null) : null,
      durationMinutes: dto.duration_minutes ?? null,
      sortOrder,
      isPreview: dto.is_preview ? 1 : 0,
      isActive: dto.is_active !== false ? 1 : 0,
    });

    return { lesson };
  }

  async updateLesson(lessonId: number, dto: UpdateLessonDto) {
    const current = await this.repository.findLessonById(lessonId);
    if (!current) throw new NotFoundException('Lesson not found');

    const contentType = dto.content_type ?? current.contentType;
    const isScorm = contentType === 'scorm';

    const lesson = await this.repository.updateLesson(lessonId, {
      title: dto.title ?? current.title,
      description:
        dto.description !== undefined ? dto.description : current.description,
      contentType,
      contentUrl: isScorm
        ? null
        : dto.content_url !== undefined
          ? dto.content_url
          : current.contentUrl,
      scormPackageId: isScorm
        ? dto.scorm_package_id !== undefined
          ? dto.scorm_package_id
          : current.scormPackageId
        : null,
      durationMinutes:
        dto.duration_minutes !== undefined
          ? dto.duration_minutes
          : current.durationMinutes,
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

    return { lesson };
  }

  async removeLesson(lessonId: number) {
    // Drop the R2 objects before the row that names them disappears —
    // afterwards there is nothing left to say which keys were this lesson's.
    // Best-effort: a storage hiccup must not block deleting the lesson (§8.4).
    await this.media.releaseLessonMedia(lessonId);
    await this.repository.deleteLesson(lessonId);
    return { message: 'Lesson deleted' };
  }

  /* ── Assignments ── */

  async listAssignments(courseId: number) {
    const [assignments, scormRows] = await Promise.all([
      this.repository.listAssignments(courseId),
      this.repository.listScormResultsForCourse(courseId),
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
    courseId: number,
    dto: BulkAssignmentDto,
    adminId: number,
  ) {
    const assigned = await this.repository.createAssignments({
      userIds: dto.user_ids,
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
  async assign(courseId: number, adminId: number, dto: CreateAssignmentDto) {
    const learner = await this.repository.findLearner(dto.user_id);
    if (!learner) throw new NotFoundException('Learner not found');

    const existing = await this.repository.findAssignment(dto.user_id, courseId);
    if (existing) {
      if (dto.due_date) {
        await this.repository.updateAssignmentDueDate(
          dto.user_id,
          courseId,
          dto.due_date,
        );
      }
      return { created: false, body: { message: 'Assignment updated' } };
    }

    await this.repository.createAssignment({
      userId: dto.user_id,
      courseId,
      assignedBy: adminId,
      dueDate: dto.due_date ?? null,
    });

    return { created: true, body: { message: 'User assigned successfully' } };
  }

  async removeAssignment(assignmentId: number) {
    await this.repository.deleteAssignment(assignmentId);
    return { message: 'Assignment removed' };
  }
}
