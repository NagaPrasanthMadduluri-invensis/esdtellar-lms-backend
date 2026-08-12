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
      });

      return { package: created };
    } catch (error) {
      // Never leave an orphaned directory behind on a failed upload.
      await this.storage.remove(packageDir);
      throw error;
    }
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
