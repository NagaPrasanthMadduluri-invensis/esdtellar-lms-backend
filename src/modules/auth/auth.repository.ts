import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { users, type UserRow } from '@/database/schema';

/**
 * All `users` reads/writes needed by authentication.
 *
 * Repositories are the only place that touches Drizzle. Services never build
 * queries, controllers never see a table — that seam is what makes the data
 * layer swappable and the services testable.
 *
 * Note every method selects an explicit column list. `SELECT *` (what the legacy
 * routes did) pulls the scrypt password hash into scope on every read, which is
 * how it ends up serialised into a response by accident.
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
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.isActive, 1)))
      .limit(1);

    return rows[0] ?? null;
  }

  async emailExists(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return rows.length > 0;
  }

  async createLearner(input: {
    firstName: string;
    lastName: string;
    email: string;
    passwordHash: string;
    department: string;
  }): Promise<UserRow> {
    const [created] = await this.db
      .insert(users)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        password: input.passwordHash,
        role: 'learner',
        department: input.department,
      })
      .returning();

    return created;
  }
}
