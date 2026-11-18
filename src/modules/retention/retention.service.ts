import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RetentionFilesService } from './retention-files.service';
import { RetentionRepository } from './retention.repository';

/** The categories with a time limit, in the order they are swept. */
export const PURGE_CATEGORIES = [
  'audit_log',
  'activity_log',
  'scorm_datamodel_log',
  'notifications_read',
  'notifications_unread',
  'failed_emails',
  'closed_data_requests',
  'reset_tokens',
  'removed_community_replies',
  'removed_community_posts',
  'stale_referrals',
] as const;

export interface RetentionResult {
  enabled: boolean;
  dryRun: boolean;
  /** Deactivated people whose window has passed. */
  candidates: number;
  /** People actually anonymised this run (0 when disabled or dry-run). */
  anonymized: number;
  /** Organizations whose scheduled data deletion ran (or would run). */
  organizations: Array<{ id: number; name: string; people: number }>;
  /** Rows deleted (or that would be) per time-limited category. */
  purged: Record<string, number>;
  /** Files removed from disk. */
  filesRemoved: number;
}

const BATCH = 500;

/**
 * Data-retention sweep (PDPA retention limitation, DPDP section 8(7), GDPR
 * storage limitation). Daily on the worker at 04:00 UTC.
 *
 * TWO guards, both off by default, because all of this is irreversible:
 *   - RETENTION_ENABLED must be 'true', or the sweep is a no-op.
 *   - RETENTION_DRY_RUN must be 'false', or it only COUNTS and logs what it
 *     would do. Roll out by enabling, reading the counts in the worker log for
 *     a few days, then turning dry-run off.
 *
 * Three jobs, in this order:
 *   1. Client offboarding: organizations whose scheduled deletion date has
 *      passed. Everyone in them is anonymised, then the organization's
 *      messages, community content, notifications and logs are removed.
 *   2. Individuals: people deactivated longer than the window are anonymised
 *      everywhere their identity was copied (RetentionRepository.anonymizeUser).
 *   3. Time limits for everybody (privacy-pack document 03 schedule).
 *
 * Files are deleted AFTER the rows are committed. A failure there leaves an
 * orphan file, never a row pointing at nothing.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly config: ConfigService,
    private readonly repo: RetentionRepository,
    private readonly files: RetentionFilesService,
  ) {}

  private days(key: string, fallback: number): number {
    const all = this.config.get<Record<string, number>>('retention.days') ?? {};
    const v = Number(all[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /**
   * `override` is for the on-demand command (`npm run retention:sweep`), which
   * always counts unless told `--apply`. The nightly job passes nothing and
   * follows RETENTION_ENABLED / RETENTION_DRY_RUN.
   */
  async sweep(override?: { enabled: boolean; dryRun: boolean }): Promise<RetentionResult> {
    const enabled = override?.enabled ?? this.config.get<boolean>('retention.enabled') ?? false;
    const dryRun = override?.dryRun ?? this.config.get<boolean>('retention.dryRun') ?? true;
    const windowDays = this.config.get<number>('retention.deactivatedUserDays') ?? 365;
    const result: RetentionResult = {
      enabled, dryRun, candidates: 0, anonymized: 0, organizations: [], purged: {}, filesRemoved: 0,
    };

    if (!enabled) {
      this.logger.log('Retention sweep skipped: set RETENTION_ENABLED=true to run it.');
      return result;
    }
    const tag = dryRun ? '[dry-run] ' : '';

    /* 1. Client offboarding */
    for (const org of await this.repo.organizationsDueForDeletion()) {
      const people = await this.repo.countUsersOfOrganization(org.id);
      result.organizations.push({ ...org, people });
      if (dryRun) continue;
      for (;;) {
        const ids = await this.repo.usersOfOrganization(org.id, BATCH);
        if (ids.length === 0) break;
        for (const id of ids) await this.anonymizeOne(id, result);
      }
      const { files } = await this.repo.purgeOrganization(org.id);
      result.filesRemoved += await this.files.remove({ shared: files });
    }
    for (const o of result.organizations) {
      this.logger.warn(
        `${tag}Organization "${o.name}" (${o.id}) is past its data deletion date: ` +
          `${o.people} people ${dryRun ? 'would be' : 'were'} anonymised and its ` +
          `messages, community content, notifications and logs ${dryRun ? 'would be' : 'were'} removed.`,
      );
    }

    /* 2. Individuals past the window */
    const cutoffIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    result.candidates = await this.repo.countAnonymizationCandidates(cutoffIso);
    if (!dryRun) {
      for (;;) {
        const ids = await this.repo.findAnonymizationCandidates(cutoffIso, BATCH);
        if (ids.length === 0) break;
        for (const id of ids) await this.anonymizeOne(id, result);
      }
    }
    this.logger.log(
      `${tag}${result.candidates} person(s) deactivated over ${windowDays} days ago ` +
        `${dryRun ? 'would be' : 'were'} anonymised.`,
    );

    /* 3. Time limits */
    for (const key of PURGE_CATEGORIES) {
      const days = this.days(key, 365);
      if (dryRun) {
        result.purged[key] = await this.repo.countDue(key, days);
        continue;
      }
      let total = 0;
      for (;;) {
        const { deleted, files } = await this.repo.purgeBatch(key, days);
        total += deleted;
        if (files.length) result.filesRemoved += await this.files.remove({ shared: files });
        if (deleted === 0) break;
      }
      result.purged[key] = total;
    }
    const certDays = this.days('certificate_files', 365);
    if (dryRun) {
      result.purged.certificate_files = await this.repo.countDueCertificateFiles(certDays);
    } else {
      let total = 0;
      for (;;) {
        const paths = await this.repo.releaseDueCertificateFiles(certDays);
        if (paths.length === 0) break;
        total += paths.length;
        result.filesRemoved += await this.files.remove({ certificates: paths });
      }
      result.purged.certificate_files = total;
    }
    const summary = Object.entries(result.purged)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    this.logger.log(
      `${tag}Time limits: ${summary || 'nothing due'}.` +
        (dryRun ? ' Set RETENTION_DRY_RUN=false to apply.' : ` Files removed: ${result.filesRemoved}.`),
    );

    return result;
  }

  private async anonymizeOne(userId: number, result: RetentionResult): Promise<void> {
    const released = await this.repo.anonymizeUser(userId);
    if (!released) return;
    result.anonymized += 1;
    result.filesRemoved += await this.files.remove(released);
  }
}
