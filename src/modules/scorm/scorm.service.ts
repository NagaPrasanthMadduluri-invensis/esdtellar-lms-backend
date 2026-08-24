import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { CertificatesService } from '@/modules/certificates/certificates.service';

import type { AssignScormDto, SaveTrackingDto } from './dto/scorm.dto';
import { parseInteractions } from './interactions.util';
import { parseManifest } from './manifest.parser';
import { ScormRepository } from './scorm.repository';
import { ScormStorageService } from './storage/scorm-storage.service';

interface CmiPayload {
  core?: {
    lesson_status?: string;
    lesson_location?: string;
    total_time?: string;
    score?: { raw?: unknown; max?: unknown };
  };
  lesson_status?: string;
  completion_status?: string;
  success_status?: string;
  score?: { raw?: unknown; max?: unknown };
  total_time?: string;
  suspend_data?: string;
  location?: string;
}

@Injectable()
export class ScormService {
  constructor(
    private readonly repository: ScormRepository,
    private readonly storage: ScormStorageService,
    private readonly certificates: CertificatesService,
  ) {}

  /* ── Admin ── */

  async listPackages() {
    return { packages: await this.repository.listPackages() };
  }

  async packageDetail(packageId: number) {
    const pkg = await this.repository.findPackageWithCourse(packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    return {
      package: pkg,
      assignments: await this.repository.packageAssignments(packageId),
    };
  }

  async upload(
    file: Express.Multer.File | undefined,
    adminId: number,
    body: { title?: string; course_id?: string },
  ) {
    if (!file) {
      throw new UnprocessableEntityException('No SCORM package file received');
    }
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw new UnprocessableEntityException(
        'File must be a .zip SCORM package',
      );
    }

    const packageDir = randomUUID();

    try {
      const manifest = await this.storage.extract(packageDir, file.buffer);
      if (manifest === null) {
        throw new UnprocessableEntityException(
          'imsmanifest.xml not found — not a valid SCORM package',
        );
      }

      const parsed = parseManifest(manifest);
      const created = await this.repository.createPackage({
        title: body.title?.trim() || parsed.title,
        version: parsed.version,
        entryPoint: parsed.entryPoint,
        packageDir,
        courseId: body.course_id ? Number(body.course_id) : null,
        createdBy: adminId,
        // Null when the manifest declares no typicalLearningTime, which is the
        // signal the lesson form uses to ask the admin for it instead.
        durationMinutes: parsed.durationMinutes,
      });

      return { package: created };
    } catch (error) {
      // Never leave an orphaned directory behind on a failed upload.
      await this.storage.remove(packageDir);
      throw error;
    }
  }

  /**
   * One learner's full attempt history on a package, for the admin view.
   *
   * Each attempt carries its own question breakdown, parsed from the CMI
   * snapshot taken at submission — so attempt 1's answers stay attempt 1's,
   * rather than every attempt showing the latest state. `reportsQuestions`
   * tells the UI whether the package emits interactions at all, so it can say
   * so instead of rendering an empty table.
   */
  async learnerAttempts(packageId: number, userId: number) {
    const pkg = await this.repository.findPackageSummary(packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    const learner = await this.repository.findLearner(userId);
    if (!learner) throw new NotFoundException('Learner not found');

    const rows = await this.repository.listAttempts(packageId, userId);

    const attempts = rows.map((row) => {
      const interactions = parseInteractions(row.cmi_data);
      return {
        id: row.id,
        attempt_number: row.attempt_number,
        score_raw: row.score_raw,
        score_max: row.score_max,
        percentage: row.percentage,
        lesson_status: row.lesson_status,
        completion_status: row.completion_status,
        success_status: row.success_status,
        // null = the package never graded this, which is not the same as failed
        is_passed: row.is_passed === null ? null : row.is_passed === 1,
        total_time: row.total_time,
        submitted_at: row.submitted_at,
        interactions,
        correct_count: interactions.filter((i) => i.isCorrect === true).length,
        question_count: interactions.length,
      };
    });

    return {
      package: { id: pkg.id, title: pkg.title, version: pkg.version },
      learner,
      attempts,
      reportsQuestions: attempts.some((a) => a.question_count > 0),
    };
  }

  async deletePackage(packageId: number) {
    const pkg = await this.repository.findPackage(packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    // Row first (cascades to assignments + tracking), then the files.
    await this.repository.deletePackage(packageId);
    await this.storage.remove(pkg.packageDir);

    return { message: 'Package deleted' };
  }

  async assign(packageId: number, adminId: number, dto: AssignScormDto) {
    const pkg = await this.repository.findPackage(packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    let targets = dto.user_ids ?? [];
    if (targets.length === 0 && dto.department) {
      targets = await this.repository.learnerIdsInDepartment(dto.department);
    }
    if (targets.length === 0) {
      throw new UnprocessableEntityException('No learners specified');
    }

    const assigned = await this.repository.assignLearners(
      packageId,
      targets,
      adminId,
    );
    return { assigned, total: targets.length };
  }

  async unassign(packageId: number, userId: number) {
    await this.repository.unassignLearner(packageId, userId);
    return { message: 'Learner removed from package' };
  }

  /* ── Learner ── */

  async listForLearner(userId: number) {
    return { packages: await this.repository.listForLearner(userId) };
  }

  async packageForLearner(userId: number, packageId: number) {
    const pkg = await this.repository.findAccessiblePackage(userId, packageId);
    if (!pkg) throw new NotFoundException('Package not found or not assigned');
    return { package: pkg };
  }

  async tracking(userId: number, packageId: number) {
    await this.assertAccess(userId, packageId);
    return { tracking: await this.repository.findTracking(userId, packageId) };
  }

  /**
   * Persists a CMI snapshot. Normalises SCORM 1.2 (fields under `cmi.core`) and
   * SCORM 2004 (fields at the root) into one row, and keeps the full blob so no
   * data is lost regardless of version.
   */
  async saveTracking(
    userId: number,
    packageId: number,
    dto: SaveTrackingDto,
  ) {
    await this.assertAccess(userId, packageId);

    // Read before the upsert overwrites it: whether this commit is the moment
    // the learner *became* finished is the only signal available for closing an
    // attempt, and it is gone once the row is updated.
    const previous = await this.repository.findTracking(userId, packageId);

    const cmi = dto.cmi_data as CmiPayload;

    const lessonStatus =
      cmi?.core?.lesson_status ?? cmi?.lesson_status ?? 'not attempted';
    const completionStatus =
      cmi?.completion_status ??
      (lessonStatus === 'completed' || lessonStatus === 'passed'
        ? 'completed'
        : 'incomplete');
    const successStatus =
      cmi?.success_status ??
      (lessonStatus === 'passed'
        ? 'passed'
        : lessonStatus === 'failed'
          ? 'failed'
          : 'unknown');

    const scoreRaw = cmi?.core?.score?.raw ?? cmi?.score?.raw ?? null;
    const scoreMax = cmi?.core?.score?.max ?? cmi?.score?.max ?? null;

    await this.repository.upsertTracking({
      userId,
      packageId,
      lessonStatus,
      completionStatus,
      successStatus,
      scoreRaw: scoreRaw !== null ? Number(scoreRaw) : null,
      scoreMax: scoreMax !== null ? Number(scoreMax) : null,
      totalTime: cmi?.core?.total_time ?? cmi?.total_time ?? null,
      suspendData: cmi?.suspend_data ?? null,
      location: cmi?.core?.lesson_location ?? cmi?.location ?? null,
      cmiData: JSON.stringify(cmi),
    });

    // When SCORM reports done, mark the embedding lesson complete so course
    // progress and certificates stay consistent with the player.
    const isDone =
      completionStatus === 'completed' ||
      lessonStatus === 'passed' ||
      lessonStatus === 'completed';

    /**
     * Close an attempt on the transition into a finished state.
     *
     * Deliberately NOT `isDone`: that decides whether the *lesson* is complete,
     * and a failed attempt must not complete a lesson or issue a certificate.
     * A failed attempt is still a submission the admin needs to see, so
     * "finished" here includes `failed` where "done" above does not.
     *
     * The player commits repeatedly — on Commit, on Finish, on unmount — so
     * appending on every finished commit would record one sitting many times.
     * Requiring the previous state to be unfinished collapses that to one row
     * per submission.
     *
     * The known cost: a package that never resets its status on a retake (no
     * `ab-initio`, stays "passed") reads as the same finished attempt, so the
     * retake is not recorded. A learner who abandons midway is likewise not
     * recorded, which is the intent.
     */
    const isSubmission = isTerminal(
      lessonStatus,
      completionStatus,
      successStatus,
    );
    const wasSubmission = isTerminal(
      previous?.lesson_status ?? null,
      previous?.completion_status ?? null,
      previous?.success_status ?? null,
    );

    if (isSubmission && !wasSubmission) {
      const percentage =
        scoreRaw !== null && scoreMax !== null && Number(scoreMax) > 0
          ? Math.round((Number(scoreRaw) / Number(scoreMax)) * 100)
          : null;

      // Null, not false, when the package only reports completion: "not graded"
      // and "failed" are different things and must not render the same.
      const isPassed =
        successStatus === 'passed' || lessonStatus === 'passed'
          ? 1
          : successStatus === 'failed' || lessonStatus === 'failed'
            ? 0
            : null;

      await this.repository.appendAttempt({
        userId,
        packageId,
        scoreRaw: scoreRaw !== null ? Number(scoreRaw) : null,
        scoreMax: scoreMax !== null ? Number(scoreMax) : null,
        percentage,
        lessonStatus,
        completionStatus,
        successStatus,
        isPassed,
        totalTime: cmi?.core?.total_time ?? cmi?.total_time ?? null,
        cmiData: JSON.stringify(cmi),
      });
    }

    if (isDone) {
      const lesson = await this.repository.findLinkedLesson(userId, packageId);
      if (lesson) {
        await this.repository.markLessonComplete(userId, Number(lesson.id));
        await this.certificates.autoIssue(userId, Number(lesson.course_id));
      }
    }

    return { message: 'Tracking saved' };
  }

  private async assertAccess(userId: number, packageId: number): Promise<void> {
    if (!(await this.repository.hasAccess(userId, packageId))) {
      throw new ForbiddenException('Not enrolled in this package');
    }
  }
}

/**
 * Has the content reported that this sitting is over — passed OR failed?
 *
 * Covers both dialects: SCORM 1.2 puts the verdict in `lesson_status`, 2004
 * splits it across `completion_status` and `success_status`.
 */
function isTerminal(
  lessonStatus: string | null,
  completionStatus: string | null,
  successStatus: string | null,
): boolean {
  return (
    completionStatus === 'completed' ||
    lessonStatus === 'passed' ||
    lessonStatus === 'completed' ||
    lessonStatus === 'failed' ||
    successStatus === 'passed' ||
    successStatus === 'failed'
  );
}
