import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RetentionRepository } from './retention.repository';

export interface RetentionResult {
  enabled: boolean;
  dryRun: boolean;
  /** How many users matched the policy this run. */
  candidates: number;
  /** How many were actually anonymised (0 when disabled or dry-run). */
  anonymized: number;
}

/**
 * Data-retention sweep (PDPA #7 — Retention Limitation).
 *
 * TWO guards, both off by default, because anonymisation is irreversible:
 *   - RETENTION_ENABLED must be 'true', or the sweep is a no-op.
 *   - RETENTION_DRY_RUN must be 'false', or it only COUNTS and logs what it
 *     would do. The intended rollout is: enable, read the dry-run count in the
 *     worker log for a few days, then turn dry-run off.
 *
 * It ANONYMISES rather than deletes: the user row stays so certificates,
 * completions and attempts keep their foreign key, but every PII column is
 * stripped. That satisfies the obligation without a cascade across ~20 tables.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly config: ConfigService,
    private readonly repo: RetentionRepository,
  ) {}

  async sweep(): Promise<RetentionResult> {
    const enabled = this.config.get<boolean>('retention.enabled') ?? false;
    const dryRun = this.config.get<boolean>('retention.dryRun') ?? true;
    const days =
      this.config.get<number>('retention.deactivatedUserDays') ?? 365;

    if (!enabled) {
      this.logger.log(
        'Retention sweep skipped — set RETENTION_ENABLED=true to run it.',
      );
      return { enabled: false, dryRun, candidates: 0, anonymized: 0 };
    }

    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const candidates = await this.repo.countAnonymizationCandidates(cutoffIso);

    if (dryRun) {
      this.logger.warn(
        `[dry-run] ${candidates} deactivated user(s) past ${days} days would be ` +
          'anonymised. Set RETENTION_DRY_RUN=false to apply.',
      );
      return { enabled: true, dryRun: true, candidates, anonymized: 0 };
    }

    let anonymized = 0;
    // Batch so one sweep never holds a lock for an unbounded UPDATE.
    for (;;) {
      const ids = await this.repo.findAnonymizationCandidates(cutoffIso, 500);
      if (ids.length === 0) break;
      anonymized += await this.repo.anonymize(ids);
    }

    this.logger.log(
      `Retention: anonymised ${anonymized} user(s) deactivated over ${days} days ago.`,
    );
    return { enabled: true, dryRun: false, candidates, anonymized };
  }
}
