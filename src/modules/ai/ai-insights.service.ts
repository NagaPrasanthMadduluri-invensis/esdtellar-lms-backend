import { Injectable, Logger } from '@nestjs/common';

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
import { assertSameTenant, fenceSystemPrompt, tenantTag } from './ai-tenant';

/** A generation request, bound to one tenant. `contextOrgId` is the org the
 *  feature context was built for — asserted against the scope before the call. */
export interface TenantGenerateParams extends AiCompletionParams {
  /** The org the context was assembled for (from the context itself). */
  contextOrgId: number;
  /** A short non-identifying subject tag for the log line, e.g. "learner=5". */
  subject: string;
}

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
  private readonly logger = new Logger('AiInsights');

  constructor(
    private readonly client: AiClientService,
    private readonly repository: AiInsightsRepository,
  ) {}

  /** Whether generation can run at all (feature on + key present). */
  isEnabled(): boolean {
    return this.client.isEnabled();
  }

  /**
   * The ONE tenant-fenced generation chokepoint (ai-tenant.ts). Every vertical
   * calls this, never the client directly, so isolation is enforced in one place:
   *   - the context's org is asserted to match the caller's scope (a mis-scoped
   *     context fails loudly here instead of leaking into a prompt);
   *   - the system prompt is fenced with the single-tenant directive;
   *   - the tenant + subject is logged for audit.
   * Best-effort: returns null on any failure, never throws into a request.
   */
  async generateForTenant<T>(
    scope: OrgScope,
    params: TenantGenerateParams,
  ): Promise<T | null> {
    assertSameTenant(scope, params.contextOrgId);
    this.logger.debug(`generate ${tenantTag(scope, params.subject)}`);
    return this.client.completeJson<T>({
      system: fenceSystemPrompt(params.system),
      user: params.user,
      jsonSchema: params.jsonSchema,
      maxTokens: params.maxTokens,
    });
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
