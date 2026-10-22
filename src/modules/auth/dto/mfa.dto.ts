import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A TOTP or recovery code, for enable / disable / verify. */
export class MfaCodeDto {
  @IsString()
  @Transform(trim)
  @MinLength(6, { message: 'Enter the code from your authenticator app' })
  @MaxLength(20)
  code!: string;
}

/** The login second-factor step: the challenge token plus the code. */
export class MfaVerifyDto {
  @IsString()
  @Transform(trim)
  @MinLength(1, { message: 'mfa_token is required' })
  @MaxLength(2000)
  mfa_token!: string;

  @IsString()
  @Transform(trim)
  @MinLength(6, { message: 'Enter the code from your authenticator app' })
  @MaxLength(20)
  code!: string;
}
