import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import {
  CERTIFICATE_PREFIX_MAX,
  CERTIFICATE_PREFIX_PATTERN,
} from '@/common/certificate-branding';

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
 * The omissions are the design:
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
 *   * **`logoUrl` IS now editable, reversing what this docblock used to say.**
 *     It was excluded because "nothing in the product renders it yet, and a
 *     field that saves happily and changes nothing visible is worse than no
 *     field". That premise is gone: the certificate prints it beside the
 *     organization's name. The argument was right and its condition expired.
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

  /**
   * The mark printed on the certificate, as a path from the image upload.
   *
   * Length-capped rather than URL-validated: the only values this should
   * ever hold are produced by `POST /api/admin/media/organization-logo`,
   * which is where the bytes are sniffed and SVG is refused (§10.10). A
   * caller that posts some other string gets a broken image on their own
   * certificate and nothing worse — it is rendered in an `img`, never
   * fetched or executed by the server.
   */
  @IsOptional() @MaxLength(500) @Transform(nullable) logo_url?: string | null;

  /**
   * Replaces the built-in `EDS` at the front of NEW certificate codes.
   *
   * Upper-cased before validation, so an admin typing `inv` is not refused
   * for a reason they cannot see. Null clears it back to the default.
   *
   * It does NOT rewrite codes already issued, and the form says so: a code
   * is printed on a document somebody holds and is what the public verify
   * route takes.
   */
  @IsOptional()
  @MaxLength(CERTIFICATE_PREFIX_MAX)
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const text = String(value).trim().toUpperCase();
    return text === '' ? null : text;
  })
  @Matches(CERTIFICATE_PREFIX_PATTERN, {
    message:
      'certificate_prefix must be 2-10 letters or digits, with no spaces or '
      + 'punctuation — the hyphen is the code\'s own separator.',
  })
  certificate_prefix?: string | null;

  /**
   * Who signs the certificate, and the title printed under the name (0039).
   * Both optional, both cleared by null or an empty string. Free text,
   * capped: this is a person's name and role as the organisation wants it
   * printed, which nothing else in the database can check.
   */
  @IsOptional() @MaxLength(80) @Transform(nullable) certificate_signatory_name?: string | null;
  @IsOptional() @MaxLength(120) @Transform(nullable) certificate_signatory_title?: string | null;
}
