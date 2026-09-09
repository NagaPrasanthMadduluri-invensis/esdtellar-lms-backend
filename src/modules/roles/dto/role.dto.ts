import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

import { ROLE_PORTALS, ROLE_SCOPES } from '@/common/permissions';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  /** Stable identifier within the organization, e.g. `trainer`. */
  @IsString()
  @MinLength(1, { message: 'key is required' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : value,
  )
  key!: string;

  @IsString()
  @MinLength(1, { message: 'label is required' })
  @Transform(trim)
  label!: string;

  @IsIn(ROLE_PORTALS, {
    message: `portal must be one of: ${ROLE_PORTALS.join(', ')}`,
  })
  portal!: (typeof ROLE_PORTALS)[number];

  @IsOptional()
  @IsIn(ROLE_SCOPES, { message: `scope must be one of: ${ROLE_SCOPES.join(', ')}` })
  scope?: (typeof ROLE_SCOPES)[number];

  /**
   * Validated against the code catalogue in the service, not here: an unknown
   * key is a 422 with the offending name, which is more use to whoever is
   * configuring roles than a generic validation failure.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @Transform(trim)
  label?: string;

  @IsOptional()
  @IsIn(ROLE_SCOPES, { message: `scope must be one of: ${ROLE_SCOPES.join(', ')}` })
  scope?: (typeof ROLE_SCOPES)[number];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];
}

export class AssignRoleDto {
  /** The role to move this user onto. Must belong to the caller's org. */
  @IsOptional()
  roleId!: number;
}
