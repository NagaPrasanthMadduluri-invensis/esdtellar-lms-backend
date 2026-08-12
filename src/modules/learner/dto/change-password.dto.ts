import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Strength rules are enforced in the service, not here, so the response can
 * name each failed rule individually — which is what the live strength meter
 * on the change-password form renders.
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'currentPassword is required' })
  currentPassword!: string;

  @IsString()
  @IsNotEmpty({ message: 'newPassword is required' })
  newPassword!: string;
}
