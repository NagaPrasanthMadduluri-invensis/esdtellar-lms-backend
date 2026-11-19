import { Injectable } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';

import {
  AiClientService,
  type AiCompletionParams,
} from './ai-client.service';
import {
  AiInsightsRepository,
  type AiInsightRow,
  type InsightSubjectType,
} from './ai-insights.repository';

/**
 * The reusable AI-insights engine (spec ai-insights.md Wave 1).
 *
 * The verticals (learner in Wave 2, admin in Wave 3) build their PII-light
 * context and a JSON schema, call `generateJson`, and persist the result with
 * `storeInsight`; the UI reads it back with `getInsight`. This service knows
 * nothing about WHAT is being generated — it only owns "ask the model, store the
 * answer, read it back", so there is one place that stamps the model and the
 * generation time.
 */
@Injectable()
export class AiInsightsService {
  constructor(
    private readonly client: AiClientService,
    private readonly repository: AiInsightsRepository,
  ) {}

  /** Whether generation can run at all (feature on + key present). */
  isEnabled(): boolean {
    return this.client.isEnabled();
  }

  /** Ask the model for structured JSON. Null when disabled or on any failure. */
  generateJson<T>(params: AiCompletionParams): Promise<T | null> {
    return this.client.completeJson<T>(params);
  }

  /** Persist (and replace) the latest insight for a subject, stamped with the model. */
  storeInsight(
    scope: OrgScope,
    subjectType: InsightSubjectType,
    subjectId: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.repository.upsert(scope, {
      subjectType,
      subjectId,
      kind,
      payload,
      model: this.client.model,
    });
  }

  getInsight(
    scope: OrgScope,
    subjectType: InsightSubjectType,
    subjectId: number,
    kind: string,
  ): Promise<AiInsightRow | null> {
    return this.repository.get(scope, subjectType, subjectId, kind);
  }
}
