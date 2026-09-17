import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Which tenant to open a support session in.
 *
 * Only an id: WHO the session becomes is resolved server-side from that
 * organization's owner admin, never named by the caller. A body-supplied user
 * id would turn one route ("open this tenant") into another ("become anyone
 * on the platform"), and the two need different arguments.
 */
export class ImpersonateDto {
  @Type(() => Number)
  @IsInt({ message: 'organization_id must be an integer' })
  @Min(1)
  organization_id!: number;
}
