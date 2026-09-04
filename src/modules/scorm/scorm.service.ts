import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { CertificatesService } from '@/modules/certificates/certificates.service';

import type {
  AssignScormDto,
  SaveTrackingDto,
  TrackDatamodelDto,
} from './dto/scorm.dto';
import { parseInteractions } from './interactions.util';
import { parseManifest } from './manifest.parser';
import type { OrgScope } from '@/database/org-scope';

import { ScormRepository } from './scorm.repository';
import { ScormDatamodelRepository } from './scorm-datamodel.repository';
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

/**
 * How long a provisional package survives unclaimed.
 *
 * Hours, not minutes, on purpose: an admin who uploads a 100 MB package and
 * then works through the rest of the lesson form must never have it deleted
 * mid-edit. The fast path is the client's own rollback, which knows
 * immediately that its save failed; this is only for the cases the client
 * cannot cover — a closed tab, a dead network, a crashed browser.
 */
const PROVISIONAL_TTL_MINUTES = 12 * 60;

@Injectable()
export class ScormService {
  private readonly logger = new Logger(ScormService.name);
  constructor(
    private readonly repository: ScormRepository,
    private readonly storage: ScormStorageService,
    private readonly datamodel: ScormDatamodelRepository,
    private readonly certificates: CertificatesService,
  ) {}

  /* ── Admin ── */

  async listPackages(scope: OrgScope) {
    return { packages: await this.repository.listPackages(scope) };
  }

  async packageDetail(scope: OrgScope, packageId: number) {
    const pkg = await this.repository.findPackageWithCourse(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    return {
      package: pkg,
      assignments: await this.repository.packageAssignments(scope, packageId),
    };
  }

  async upload(
    scope: OrgScope,
    file: Express.Multer.File | undefined,
    adminId: number,
    body: { title?: string; course_id?: string; provisional?: string },
  ) {
    if (!file) {
      throw new UnprocessableEntityException('No SCORM package file received');
    }
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw new UnprocessableEntityException(
        'File must be a .zip SCORM package',
      );
    }

    // Fail before decompressing: on the s3 driver a missing credential is a
    // 503, and spending CPU unzipping 100 MB first only delays the same answer.
    if (!this.storage.isReady) {
      throw new ServiceUnavailableException(
        `SCORM storage (driver "${this.storage.driverKind}") is not configured ` +
          `on this server. Missing: ${this.storage.missingConfig.join(', ')}. ` +
          'Set them on the API server and restart it — configuration is read ' +
          'once at startup.',
      );
    }

    /**
     * Collect abandoned provisional uploads before adding another. No
     * scheduler exists in this codebase, and adding one to run a query that is
     * almost always empty would be disproportionate — an upload is exactly the
     * moment debris from a previous upload is worth clearing, and it is the
     * only moment this endpoint is reached. Failure here must never fail the
     * upload (§8.4).
     */
    void this.sweepProvisional();

    const isProvisional =
      body.provisional === '1' ||
      body.provisional === 'true';

    const packageDir = randomUUID();
    // Captured so the catch block can clean up whichever storage was used.
    // On s3 the prefix is only known after extract() returns, so the fallback
    // is the driver's own reconstruction from packageDir.
    let storagePrefix: string | null = null;

    try {
      const extracted = await this.storage.extract(
        packageDir,
        file.buffer,
        // The OWNER's org — this is what becomes the tenant segment of the key
        // prefix, and it is taken from the verified scope, never the body.
        scope.organizationId,
      );
      if (extracted === null) {
        throw new UnprocessableEntityException(
          'imsmanifest.xml not found — not a valid SCORM package',
        );
      }
      storagePrefix = extracted.storagePrefix;

      const parsed = parseManifest(extracted.manifestXml);
      const created = await this.repository.createPackage(scope, {
        title: body.title?.trim() || parsed.title,
        version: parsed.version,
        entryPoint: parsed.entryPoint,
        packageDir,
        // Null on the local driver; the key prefix on s3. This is what makes
        // the two drivers coexist per package rather than as a flag day.
        storagePrefix,
        /**
         * The lesson editor sends `provisional` because it must upload before
         * it can save the lesson, so its package is not real until that lesson
         * lands. Every other caller (the SCORM library page) is claimed at
         * once, which is why the flag is opt-IN rather than the default —
         * an existing caller cannot accidentally create sweepable debris.
         */
        claimedAt: isProvisional ? null : new Date().toISOString(),
        courseId: body.course_id ? Number(body.course_id) : null,
        createdBy: adminId,
        // Null when the manifest declares no typicalLearningTime, which is the
        // signal the lesson form uses to ask the admin for it instead.
        durationMinutes: parsed.durationMinutes,
      });

      return { package: created };
    } catch (error) {
      // Never leave orphaned files behind on a failed upload — on s3 those are
      // objects nothing references, billed forever.
      await this.storage.remove({ packageDir, storagePrefix });
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
  async learnerAttempts(scope: OrgScope, packageId: number, userId: number) {
    const pkg = await this.repository.findPackageSummary(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    const learner = await this.repository.findLearner(scope, userId);
    if (!learner) throw new NotFoundException('Learner not found');

    const rows = await this.repository.listAttempts(scope, packageId, userId);

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


  /**
   * Persists a batch of SCORM data-model deltas.
   *
   * Access is re-checked on every batch rather than trusted from the launch:
   * the player holds the tab open for as long as the learner leaves it open,
   * and an assignment can be revoked in the meantime. Cheaper than it looks —
   * one `hasAccess` query, and flushes are batched by the bridge rather than
   * sent per SetValue.
   *
   * 404, not 403, for a package the learner cannot reach. A 403 would confirm
   * the package exists, which is the one thing a caller probing package ids is
   * trying to learn — the same reasoning as `ScormContentMiddleware`. Note the
   * deliberate difference from §5.3's general rule: there, 403-vs-404 tells an
   * owner something useful about their own resource; here the id space is
   * guessable and the distinction leaks.
   */
  async trackDatamodel(
    scope: OrgScope,
    userId: number,
    packageId: number,
    dto: TrackDatamodelDto,
  ) {
    const pkg = await this.repository.findPackageSummary(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    const allowed = await this.repository.hasAccess(scope, userId, packageId);
    if (!allowed) throw new NotFoundException('Package not found');

    const written = await this.datamodel.insertBatch(
      scope,
      userId,
      packageId,
      dto.deltas.map((delta) => ({
        elementKey: delta.element_key,
        // undefined (absent) and null (explicitly cleared) both store as NULL.
        elementValue: delta.element_value ?? null,
      })),
    );

    // The count is returned rather than a bare { ok: true } so the bridge can
    // tell a partially-rejected batch from a delivered one instead of assuming.
    return { tracked: written };
  }

  /** One learner's own runtime timeline, paginated (§7.6). */
  async datamodelForLearner(
    scope: OrgScope,
    userId: number,
    packageId: number,
    limit: number,
    offset: number,
  ) {
    const allowed = await this.repository.hasAccess(scope, userId, packageId);
    if (!allowed) throw new NotFoundException('Package not found');

    const [entries, total] = await Promise.all([
      this.datamodel.listForLearner(scope, userId, packageId, limit, offset),
      this.datamodel.countForLearner(scope, userId, packageId),
    ]);
    return { entries, total, limit, offset };
  }

  /**
   * An admin reading one learner's timeline. Separate from the learner method
   * because the ownership rule is different — an admin is allowed to read a
   * learner they do not own the row of, but only inside their own org, which
   * `findLearner` enforces before anything is returned.
   */
  async datamodelForAdmin(
    scope: OrgScope,
    packageId: number,
    userId: number,
    limit: number,
    offset: number,
  ) {
    const pkg = await this.repository.findPackageSummary(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    const learner = await this.repository.findLearner(scope, userId);
    if (!learner) throw new NotFoundException('Learner not found');

    const [entries, total, latest] = await Promise.all([
      this.datamodel.listForLearner(scope, userId, packageId, limit, offset),
      this.datamodel.countForLearner(scope, userId, packageId),
      this.datamodel.latestByElement(scope, userId, packageId),
    ]);

    return {
      package: { id: pkg.id, title: pkg.title, version: pkg.version },
      learner,
      entries,
      total,
      limit,
      offset,
      // The reconstructed current data model, so the screen does not have to
      // fold the timeline itself and get a different answer than the DB would.
      latest,
    };
  }


  /**
   * Marks a package as in use, called when a lesson successfully references it.
   * Exported through the module so `CoursesService` can reach it — the
   * repository stays private (§3.2).
   */
  async claimPackage(scope: OrgScope, packageId: number): Promise<void> {
    await this.repository.claimPackage(scope, packageId);
  }

  /**
   * Deletes provisional packages nothing claimed, and their files.
   *
   * Best-effort in the strongest sense: it is housekeeping, it is triggered by
   * an unrelated request, and nothing about the caller depends on it. Every
   * failure is logged and swallowed (§8.4).
   */
  async sweepProvisional(): Promise<number> {
    try {
      const abandoned = await this.repository.sweepUnclaimed(
        PROVISIONAL_TTL_MINUTES,
      );
      for (const location of abandoned) {
        await this.storage.remove(location);
      }
      if (abandoned.length > 0) {
        this.logger.log(
          `Swept ${abandoned.length} abandoned provisional SCORM package(s).`,
        );
      }
      return abandoned.length;
    } catch (error) {
      this.logger.warn(
        `Provisional SCORM sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  async deletePackage(scope: OrgScope, packageId: number) {
    const pkg = await this.repository.findPackage(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    // Row first (cascades to assignments + tracking), then the files.
    await this.repository.deletePackage(scope, packageId);
    await this.storage.remove({
      packageDir: pkg.packageDir,
      storagePrefix: pkg.storagePrefix ?? null,
    });

    return { message: 'Package deleted' };
  }

  async assign(scope: OrgScope, packageId: number, adminId: number, dto: AssignScormDto) {
    const pkg = await this.repository.findPackage(scope, packageId);
    if (!pkg) throw new NotFoundException('Package not found');

    let targets = dto.user_ids ?? [];
    if (targets.length === 0 && dto.department) {
      // Already scoped — a department query cannot reach another org.
      targets = await this.repository.learnerIdsInDepartment(scope, dto.department);
    } else if (targets.length > 0) {
      // user_ids come from the request body, so they are caller-supplied and
      // must be filtered to this organization. The composite FK would reject
      // a foreign id, but as a constraint violation — one bad id would fail
      // the whole batch and answer the admin with "Internal server error"
      // instead of a 404 naming the problem.
      const inScope = await this.repository.filterLearnersInOrg(scope, targets);
      if (inScope.length !== targets.length) {
        throw new NotFoundException('One or more learners were not found');
      }
      targets = inScope;
    }
    if (targets.length === 0) {
      throw new UnprocessableEntityException('No learners specified');
    }

    const assigned = await this.repository.assignLearners(
      scope,
      packageId,
      targets,
      adminId,
    );
    return { assigned, total: targets.length };
  }

  async unassign(scope: OrgScope, packageId: number, userId: number) {
    await this.repository.unassignLearner(scope, packageId, userId);
    return { message: 'Learner removed from package' };
  }

  /**
   * Entitlement check for the SCORM static-content middleware
   * (`multi-tenancy.md` §3.9). The middleware sits outside the Nest guard
   * chain — it authenticates the token by hand — but must still route
   * through this service rather than the repository directly
   * (`BACKEND_STRUCTURE.md` §3: never skip a layer; this is a business
   * rule, not a raw query).
   */
  /**
   * Called by `ScormContentMiddleware`, which runs OUTSIDE the Nest guard
   * chain and therefore has no `@CurrentScope()`. It mints the scope from the
   * organizationId in the verified JWT instead — the same claim
   * TenantContextGuard would have used.
   */
  async isEntitledToPackageDir(
    scope: OrgScope,
    userId: number,
    packageDir: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    return this.repository.isEntitledByPackageDir(
      scope,
      userId,
      packageDir,
      isAdmin,
    );
  }

  /**
   * Throws unless `packageId` is visible to this organization.
   *
   * `lessons.scorm_package_id` is a SINGLE-column foreign key: the composite
   * set deliberately excludes the activity/content edge, because SQL cannot
   * express "my org OR the platform org" (§3.5). So the database CANNOT catch
   * a cross-org reference here, and this is the enforcement point the spec
   * names (§3.4, §6.15).
   *
   * Without it an admin who cannot SEE another org's package can still
   * REFERENCE it by guessing an id, and its title and version then surface
   * through the learner-detail read.
   */
  async assertPackageInScope(
    scope: OrgScope,
    packageId: number,
  ): Promise<void> {
    const pkg = await this.repository.findPackage(scope, packageId);
    if (!pkg) throw new NotFoundException('SCORM package not found');
  }

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    return { packages: await this.repository.listForLearner(scope, userId) };
  }

  async packageForLearner(scope: OrgScope, userId: number, packageId: number) {
    const pkg = await this.repository.findAccessiblePackage(scope, userId, packageId);
    if (!pkg) throw new NotFoundException('Package not found or not assigned');
    return { package: pkg };
  }

  async tracking(scope: OrgScope, userId: number, packageId: number) {
    await this.assertAccess(scope, userId, packageId);
    return { tracking: await this.repository.findTracking(scope, userId, packageId) };
  }

  /**
   * Persists a CMI snapshot. Normalises SCORM 1.2 (fields under `cmi.core`) and
   * SCORM 2004 (fields at the root) into one row, and keeps the full blob so no
   * data is lost regardless of version.
   */
  async saveTracking(
    scope: OrgScope,
    userId: number,
    packageId: number,
    dto: SaveTrackingDto,
  ) {
    await this.assertAccess(scope, userId, packageId);

    // Read before the upsert overwrites it: whether this commit is the moment
    // the learner *became* finished is the only signal available for closing an
    // attempt, and it is gone once the row is updated.
    const previous = await this.repository.findTracking(scope, userId, packageId);

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

    await this.repository.upsertTracking(scope, {
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

      await this.repository.appendAttempt(scope, {
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
      const lesson = await this.repository.findLinkedLesson(scope, userId, packageId);
      if (lesson) {
        await this.repository.markLessonComplete(scope, userId, Number(lesson.id));
        await this.certificates.autoIssue(scope, userId, Number(lesson.course_id));
      }
    }

    return { message: 'Tracking saved' };
  }

  private async assertAccess(
    scope: OrgScope,
    userId: number,
    packageId: number,
  ): Promise<void> {
    if (!(await this.repository.hasAccess(scope, userId, packageId))) {
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
