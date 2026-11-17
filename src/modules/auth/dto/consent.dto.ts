import { IsBoolean, IsOptional } from 'class-validator';

/**
 * POST /auth/consent (0057, choices added with 0065).
 *
 * The acknowledgement itself carries no field: the version is the server's
 * CURRENT_PRIVACY_VERSION, never the caller's. The two optional booleans are a
 * SNAPSHOT of the choices the person was shown on the notice screen, recorded
 * in the consent log beside the acknowledgement. They are not applied here:
 * the screen saves each changed choice through its own route first
 * (PATCH /auth/profile, PATCH /auth/email-preferences), and those routes log
 * the change themselves. One writer per setting.
 */
export class RecordConsentDto {
  @IsOptional()
  @IsBoolean()
  leaderboard_visible?: boolean;

  @IsOptional()
  @IsBoolean()
  recognition_emails?: boolean;
}
