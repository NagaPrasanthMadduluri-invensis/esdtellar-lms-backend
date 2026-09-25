import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

export interface OptionRow {
  id: number;
  name: string;
  sort_order: number;
  is_active: number;
  country_code?: string | null;
  country_name?: string | null;
  state_name?: string | null;
}

/**
 * Branch locations and job levels, per organization.
 *
 * Raw SQL throughout so the whole file speaks snake_case — no casing seam of
 * the kind §10.10 records seven times.
 *
 * Every method takes `organizationId` explicitly rather than an `OrgScope`:
 * the platform routes act on a tenant named in the path (a delegated write,
 * §5.2.1) while the tenant route acts on its own scope, and passing the bare
 * id makes the caller state which it is. The guard on each controller is what
 * decides whether that id may be anything other than the caller's own.
 */
@Injectable()
export class OrgOptionsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async listLocations(organizationId: number, activeOnly: boolean) {
    return this.db.all<OptionRow>(sql`
      SELECT id, name, country_code, country_name, state_name, sort_order, is_active
        FROM organization_locations
       WHERE organization_id = ${organizationId}
         ${activeOnly ? sql`AND is_active = 1` : sql``}
       ORDER BY sort_order, lower(name)
    `);
  }

  async listJobLevels(organizationId: number, activeOnly: boolean) {
    return this.db.all<OptionRow>(sql`
      SELECT id, name, sort_order, is_active
        FROM organization_job_levels
       WHERE organization_id = ${organizationId}
         ${activeOnly ? sql`AND is_active = 1` : sql``}
       ORDER BY sort_order, lower(name)
    `);
  }

  /**
   * Replace an organization's branch locations with exactly this set.
   *
   * A REPLACE rather than a diff, and the distinction matters: removal is a
   * deactivation, never a delete. A location no longer offered still names
   * where somebody worked, and `users.location` holds that text with no
   * foreign key to protect it (see `0031`) — so deleting the row would leave
   * a value nothing could explain. Anything absent from the new set is simply
   * marked inactive and stops appearing in pickers.
   */
  async replaceLocations(
    organizationId: number,
    items: {
      name: string;
      countryCode?: string | null;
      countryName?: string | null;
      stateName?: string | null;
    }[],
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE organization_locations SET is_active = 0
       WHERE organization_id = ${organizationId}
    `);
    if (items.length === 0) return;

    // One multi-row upsert, never one statement per branch (§7.1).
    const values = items.map(
      (it, i) => sql`(${organizationId}, ${it.name}, ${it.countryCode ?? null},
                      ${it.countryName ?? null}, ${it.stateName ?? null}, ${i}, 1)`,
    );
    await this.db.run(sql`
      INSERT INTO organization_locations
        (organization_id, name, country_code, country_name, state_name, sort_order, is_active)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (organization_id, lower(name)) DO UPDATE
        SET is_active    = 1,
            sort_order   = EXCLUDED.sort_order,
            country_code = EXCLUDED.country_code,
            country_name = EXCLUDED.country_name,
            state_name   = EXCLUDED.state_name
    `);
  }

  /** Same shape, same reasoning — see `replaceLocations`. */
  async replaceJobLevels(
    organizationId: number,
    names: string[],
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE organization_job_levels SET is_active = 0
       WHERE organization_id = ${organizationId}
    `);
    if (names.length === 0) return;

    const values = names.map((name, i) => sql`(${organizationId}, ${name}, ${i}, 1)`);
    await this.db.run(sql`
      INSERT INTO organization_job_levels
        (organization_id, name, sort_order, is_active)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (organization_id, lower(name)) DO UPDATE
        SET is_active = 1, sort_order = EXCLUDED.sort_order
    `);
  }

  /** Seed a brand-new tenant so its admin is not handed empty dropdowns. */
  async seedJobLevels(organizationId: number, names: string[]): Promise<void> {
    if (names.length === 0) return;
    const values = names.map((name, i) => sql`(${organizationId}, ${name}, ${i}, 1)`);
    await this.db.run(sql`
      INSERT INTO organization_job_levels
        (organization_id, name, sort_order, is_active)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT DO NOTHING
    `);
  }
}
