import type { Request } from 'express';

export type UserRole = 'admin' | 'learner';

/**
 * The verified JWT claims. `userId` is the `users.id` primary key — the legacy
 * code named this claim `userId` (never `id`) and route handlers relied on it,
 * so the name is preserved.
 */
export interface JwtPayload {
  userId: number;
  role: UserRole;
  email: string;
  firstName: string;
  lastName: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

/** What `@CurrentUser()` hands to a controller. */
export type AuthenticatedUser = Omit<JwtPayload, 'exp'>;

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
