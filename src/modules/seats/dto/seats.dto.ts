import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, MaxLength, Min } from 'class-validator';

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** A tenant asking for more seats. */
export class SeatRequestDto {
  @Type(() => Number)
  @IsInt({ message: 'requested_seats must be a whole number' })
  @Min(1, { message: 'Ask for at least one seat' })
  requested_seats!: number;

  @IsOptional() @MaxLength(1000) @Transform(nullable) reason?: string | null;
}

/** Edstellar's decision. Approving WRITES the tenant's seat limit. */
export class RespondToSeatsDto {
  @IsIn(['approved', 'declined'], {
    message: 'status must be approved or declined',
  })
  status!: 'approved' | 'declined';

  /** May differ from what was asked — grant 40 against a request for 50. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  approved_seats?: number;

  @IsOptional() @MaxLength(1000) @Transform(nullable) response_note?: string | null;
}

/** Set a limit directly. `null` clears it back to unlimited. */
export class SetSeatLimitDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'seat_limit must be a whole number' })
  @Min(0, { message: 'seat_limit cannot be negative' })
  seat_limit?: number | null;
}
