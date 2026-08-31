import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { organizations } from '@/database/schema';

/**
 * Deliberately NOT org-scoped, like `auth.repository.ts`: resolving the
 * platform organization's id is what makes `OrgScope` possible in the first
 * place, so it cannot depend on one.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async findPlatformOrganizationId(): Promise<number | null> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.isPlatform, true))
      .limit(1);

    return rows[0]?.id ?? null;
  }
}
