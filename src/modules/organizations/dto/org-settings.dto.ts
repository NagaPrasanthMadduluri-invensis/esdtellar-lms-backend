import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * What a TENANT admin may change about their own organization.
 *
 * Three fields, and the omissions are the design:
 *
 *   * **No `slug`.** It is the account's stable identifier and is unique
 *     platform-wide; letting a tenant change it invites a collision that only
 *     the platform can adjudicate.
 *   * **No `isActive`.** Suspending an account is Edstellar's decision, and
 *     a tenant deactivating its own organization would lock every one of its
 *     users out with no way back in from their side.
 *   * **No contract, plan, billing cycle or seat limit.** These are what the
 *     customer bought. A tenant editing its own commercial terms, or raising
 *     its own seat cap, would make both the contract warnings and the seat
 *     enforcement decorative. They stay `@PlatformAdmin()` and are returned
 *     READ-ONLY on the GET, because the customer is entitled to see their own
 *     terms — just not to rewrite them.
 *   * **No `logoUrl`.** Nothing in the product renders it yet, and a field
 *     that saves happily and changes nothing visible is worse than no field.
 */
export class UpdateOrgSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name cannot be empty' })
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @IsOptional() @MaxLength(80) @Transform(nullable) industry?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) region?: string | null;
}
