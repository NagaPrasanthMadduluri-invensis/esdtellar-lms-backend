import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export type InsightSubjectType = 'learner' | 'org';

export interface AiInsightRow {
  subject_type: string;
  subject_id: number;
  kind: string;
  payload: Record<string, unknown>;
  model: string;
  generated_at: string;
}

/**
 * Storage for generated insights (0071). ACTIVITY, so every query is `orgScope`:
 * an insight belongs to the tenant it was generated for.
 */
@Injectable()
export class AiInsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** One latest insight per (org, subject, kind) — a refresh replaces it. */
  async upsert(
    scope: OrgScope,
    input: {
      subjectType: InsightSubjectType;
      subjectId: number;
      kind: string;
      payload: Record<string, unknown>;
      model: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO ai_insights
        (organization_id, subject_type, subject_id, kind, payload, model, generated_at)
      VALUES (
        ${scope.organizationId}, ${input.subjectType}, ${input.subjectId},
        ${input.kind}, ${JSON.stringify(input.payload)}::jsonb, ${input.model}, now()
      )
      ON CONFLICT (organization_id, subject_type, subject_id, kind) DO UPDATE SET
        payload = excluded.payload, model = excluded.model, generated_at = now()
    `);
  }

  async get(
    scope: OrgScope,
    subjectType: InsightSubjectType,
    subjectId: number,
    kind: string,
  ): Promise<AiInsightRow | null> {
    const rows = await this.db.all<AiInsightRow>(sql`
      SELECT ai.subject_type, ai.subject_id, ai.kind, ai.payload, ai.model, ai.generated_at
      FROM ai_insights ai
      WHERE ${orgScope('ai', scope)}
        AND ai.subject_type = ${subjectType}
        AND ai.subject_id = ${subjectId}
        AND ai.kind = ${kind}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
