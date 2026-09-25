import { Injectable } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';

import { OrgOptionsRepository } from './org-options.repository';
import type { SetJobLevelsDto, SetLocationsDto } from './dto/org-options.dto';

/**
 * What a new tenant starts with, so its admin is never handed an empty
 * dropdown on the first learner they onboard.
 *
 * This is the old `common/workforce.ts` constant in its last role: not a rule
 * any more, just a sensible opening position the platform admin can edit.
 * Branch locations get NO default — Edstellar cannot guess where a customer's
 * offices are, and a wrong guess is worse than an empty list the onboarding
 * form actively asks them to fill.
 */
export const DEFAULT_JOB_LEVELS = [
  'Executive', 'Senior', 'Manager', 'Mid', 'Junior', 'Intern',
];

@Injectable()
export class OrgOptionsService {
  constructor(private readonly repository: OrgOptionsRepository) {}

  /** Everything a form needs, in one call — two lists, one round trip. */
  async optionsFor(organizationId: number, activeOnly = true) {
    const [locations, jobLevels] = await Promise.all([
      this.repository.listLocations(organizationId, activeOnly),
      this.repository.listJobLevels(organizationId, activeOnly),
    ]);
    return {
      locations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        country_code: l.country_code ?? null,
        country_name: l.country_name ?? null,
        state_name: l.state_name ?? null,
        is_active: l.is_active === 1,
      })),
      job_levels: jobLevels.map((j) => ({
        id: j.id,
        name: j.name,
        is_active: j.is_active === 1,
      })),
    };
  }

  /** The tenant's own, active only — what its forms may offer. */
  async forScope(scope: OrgScope) {
    return this.optionsFor(scope.organizationId, true);
  }

  async setLocations(organizationId: number, dto: SetLocationsDto) {
    await this.repository.replaceLocations(
      organizationId,
      // De-duplicated case-insensitively before it reaches the unique index,
      // so a form that offers "Pune" twice is a no-op rather than a 500.
      dedupe(dto.locations.map((l) => l.name)).map((name) => {
        const src = dto.locations.find(
          (l) => l.name.toLowerCase() === name.toLowerCase(),
        )!;
        return {
          name: src.name,
          countryCode: src.country_code ?? null,
          countryName: src.country_name ?? null,
          stateName: src.state_name ?? null,
        };
      }),
    );
    return this.optionsFor(organizationId, false);
  }

  async setJobLevels(organizationId: number, dto: SetJobLevelsDto) {
    const names = dedupe(
      dto.job_levels.map((n) => n.trim()).filter((n) => n.length > 0),
    );
    await this.repository.replaceJobLevels(organizationId, names);
    return this.optionsFor(organizationId, false);
  }

  /** Called when a tenant is created. */
  async seedDefaults(organizationId: number) {
    await this.repository.seedJobLevels(organizationId, DEFAULT_JOB_LEVELS);
  }

  /* ── Validation, replacing the old `@IsIn` on a constant ───────────────
   *
   * This moved from the DTO to the service on purpose. `@IsIn` compares
   * against a value known at import time; the valid set is now a per-tenant
   * query, which a decorator cannot do. The API is still what enforces it —
   * the check simply had to move to the layer that can see the organization
   * (§3: business rules are the service's).
   */

  /** Is this a branch location this organization actually offers? */
  async assertLocation(
    organizationId: number,
    value: string | null | undefined,
  ): Promise<string | null> {
    return this.assertOneOf(organizationId, value, 'location');
  }

  async assertJobLevel(
    organizationId: number,
    value: string | null | undefined,
  ): Promise<string | null> {
    return this.assertOneOf(organizationId, value, 'job_level');
  }

  private async assertOneOf(
    organizationId: number,
    value: string | null | undefined,
    field: 'location' | 'job_level',
  ): Promise<string | null> {
    if (value === undefined || value === null || value === '') return null;

    const rows =
      field === 'location'
        ? await this.repository.listLocations(organizationId, true)
        : await this.repository.listJobLevels(organizationId, true);

    // Matched case-insensitively but stored in the LIST's casing, so the
    // column holds one spelling of each value no matter what a bulk import
    // typed — that is the whole reason these are closed lists (§10.3.1.1).
    const hit = rows.find(
      (r) => r.name.toLowerCase() === String(value).trim().toLowerCase(),
    );
    if (hit) return hit.name;

    const valid = rows.map((r) => r.name);
    throw new OptionNotOfferedError(field, valid);
  }
}

/**
 * Thrown by the service, translated to a 422 by whichever caller knows the
 * HTTP shape. A repository never throws HTTP (§3.1) and neither should this —
 * the bulk importer wants to report it per row, not fail the request.
 */
export class OptionNotOfferedError extends Error {
  constructor(
    readonly field: 'location' | 'job_level',
    readonly valid: string[],
  ) {
    super(
      valid.length === 0
        ? `No ${field === 'location' ? 'branch locations' : 'job levels'} have been set up for this organization yet. Ask Edstellar to add them.`
        : `${field === 'location' ? 'Location' : 'Job level'} must be one of: ${valid.join(', ')}`,
    );
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}
