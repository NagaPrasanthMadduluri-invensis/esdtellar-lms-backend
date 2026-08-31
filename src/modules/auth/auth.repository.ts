import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { users } from '@/database/schema';

/**
 * All `users` reads needed by authentication.
 *
 * Repositories are the only place that touches Drizzle. Services never build
 * queries, controllers never see a table — that seam is what makes the data
 * layer swappable and the services testable.
 *
 * Note every method selects an explicit column list. `SELECT *` (what the legacy
 * routes did) pulls the scrypt password hash into scope on every read, which is
 * how it ends up serialised into a response by accident.
 *
 * Deliberately NOT `OrgScope`d, unlike every other repository. Login resolves
 * a globally-unique email (`users.email UNIQUE`, spec decision 1) BEFORE any
 * scope exists — there is no JWT yet to mint one from. This is correct, not
 * an oversight: it is one of exactly two repositories a grep for `orgScope`
 * is expected to miss (the other is `platform-analytics.repository.ts`,
 * spec §4.3/acceptance criterion 6). Do not "fix" this by adding a scope
 * parameter that can never be supplied.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Includes the password hash — used ONLY by the login credential check. */
  async findActiveByEmailWithSecret(email: string) {
    const rows = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        password: users.password,
        role: users.role,
        department: users.department,
        isActive: users.isActive,
        organizationId: users.organizationId,
      })
      .from(users)
      .where(and(eq(users.email, email), eq(users.isActive, 1)))
      .limit(1);

    return rows[0] ?? null;
  }

  async findActiveById(id: number) {
    const rows = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        department: users.department,
        isActive: users.isActive,
        organizationId: users.organizationId,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.isActive, 1)))
      .limit(1);

    return rows[0] ?? null;
  }
}
