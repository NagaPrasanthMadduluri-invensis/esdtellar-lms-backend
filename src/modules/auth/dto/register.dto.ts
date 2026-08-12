import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';

/** Mirrors the department options offered by the register form. */
export const VALID_DEPARTMENTS = [
  'Sales',
  'HR',
  'Technology',
  'Finance',
  'Marketing',
  'Operations',
  'Legal',
  'Customer Support',
  'Product',
  'Design',
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDto {
  @IsString()
  @MinLength(1, { message: 'first_name is required' })
  @Transform(trim)
  first_name!: string;

  @IsString()
  @MinLength(1, { message: 'last_name is required' })
  @Transform(trim)
  last_name!: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;

  @IsIn(VALID_DEPARTMENTS as unknown as string[], {
    message: 'department must be a valid department',
  })
  department!: string;
}
