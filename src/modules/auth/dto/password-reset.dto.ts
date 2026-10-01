import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RequestPasswordResetDto {
  /**
   * `@IsEmail` here is a FORMAT check, not an existence check, and the
   * difference matters: a malformed address is rejected with a 400 because
   * nothing could ever match it, while a well-formed address that has no
   * account gets the same neutral 200 as one that does. Rejecting only
   * garbage keeps the enumeration oracle closed (§5.3).
   */
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(20, { message: 'This reset link is not valid' })
  @MaxLength(200)
  token!: string;

  /**
   * Only a floor and a ceiling here. The four strength rules live in the
   * service and are reported field by field, because the form renders a
   * live strength meter and a flat "does not meet requirements" would
   * leave it with nothing to light up — the same reasoning
   * `changePassword` already follows.
   *
   * The ceiling is not cosmetic: `scryptSync` is CPU-bound and
   * synchronous, so an unbounded password is a one-request denial of
   * service against a single-process API.
   */
  @IsString()
  @MinLength(8, { message: 'Must be at least 8 characters' })
  @MaxLength(200)
  newPassword!: string;
}
