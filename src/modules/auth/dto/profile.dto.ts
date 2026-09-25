import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';


const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Omitted stays undefined (leave alone); an explicit blank becomes null. */
const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * What a person may change about THEMSELVES.
 *
 * The list is short on purpose, and what is missing matters more than what is
 * here:
 *
 *   * **`email` is not editable.** It is the login identity. Changing it needs
 *     a uniqueness check, and more to the point it needs the change to be
 *     verified by somebody other than the person making it. An admin edits it
 *     from Manage Users.
 *   * **`department` is not editable.** It is an AUTHORISATION boundary, not
 *     a label: a Manager's row scope is their department (`specs/rbac.md`
 *     decision 3), so a learner who could set their own would choose which
 *     manager sees them, and could move themselves out of view entirely.
 *   * **`role`, `role_id` and `is_active` are not here at all.** Self-service
 *     promotion is the obvious thing to get wrong once, and there is no
 *     reason for this DTO to be the place it becomes possible.
 *
 * `job_level` and `location` ARE editable and are validated against this
 * ORGANIZATION's curated lists, exactly as the admin's user form is — one
 * rule, whichever screen sent it.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'first name cannot be empty' })
  @MaxLength(80)
  @Transform(trim)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'last name cannot be empty' })
  @MaxLength(80)
  @Transform(trim)
  last_name?: string;

  @IsOptional() @MaxLength(40) @Transform(nullable) phone?: string | null;
  @IsOptional() @MaxLength(120) @Transform(nullable) job_role?: string | null;

  /*
   * NOT `@IsIn` any more: the valid set is this organization's own list
   * (`0031`), which is a query, and a decorator is evaluated at import time.
   * `AuthService.updateProfile` checks both against `OrgOptionsService` and
   * throws 422 with the tenant's own valid values — the enforcement moved to
   * the layer that can see the organization (§3), it did not go away. Writing
   * a value nothing can filter on is the silent-omission failure §10.12
   * records, so this is the one place the check must stay.
   */
  @IsOptional() @IsString() @MaxLength(120) @Transform(nullable)
  job_level?: string | null;

  @IsOptional() @IsString() @MaxLength(120) @Transform(nullable)
  location?: string | null;
}
