import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { INVOICE_STATUSES, PAYMENT_METHODS } from '@/common/billing';

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class CreateInvoiceDto {
  @IsInt({ message: 'organization_id must be an integer' })
  organization_id!: number;

  /** Omitted means the server allocates the next number for the year. */
  @IsOptional() @MaxLength(40) @Transform(nullable) invoice_no?: string | null;

  @IsString() @MinLength(1, { message: 'issue_date is required' }) issue_date!: string;
  @IsString() @MinLength(1, { message: 'due_date is required' }) due_date!: string;

  /**
   * Accepted as a number and stored as `numeric`. `Min(0)` because a negative
   * invoice is a credit note — a different document with different handling,
   * not an invoice with a minus sign.
   */
  @Type(() => Number)
  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0, { message: 'amount cannot be negative' })
  amount!: number;

  @IsOptional()
  @IsIn(INVOICE_STATUSES, {
    message: `status must be one of: ${INVOICE_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @MaxLength(300) @Transform(nullable) description?: string | null;
  @IsOptional() @MaxLength(2000) @Transform(nullable) notes?: string | null;
}

export class UpdateInvoiceDto {
  @IsOptional() @Transform(nullable) issue_date?: string | null;
  @IsOptional() @Transform(nullable) due_date?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0, { message: 'amount cannot be negative' })
  amount?: number;

  @IsOptional()
  @IsIn(INVOICE_STATUSES, {
    message: `status must be one of: ${INVOICE_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @MaxLength(300) @Transform(nullable) description?: string | null;
  @IsOptional() @MaxLength(2000) @Transform(nullable) notes?: string | null;
}

/** Money that actually arrived. */
export class RecordPaymentDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0.01, { message: 'A payment must be greater than zero' })
  amount!: number;

  @IsString() @MinLength(1, { message: 'paid_on is required' }) paid_on!: string;

  @IsOptional()
  @IsIn(PAYMENT_METHODS, {
    message: `method must be one of: ${PAYMENT_METHODS.join(', ')}`,
  })
  method?: string;

  @IsOptional() @MaxLength(120) @Transform(nullable) reference?: string | null;
  @IsOptional() @MaxLength(500) @Transform(nullable) notes?: string | null;
}

export class ListInvoicesDto {
  @IsOptional() @Type(() => Number) @IsInt() organization_id?: number;

  @IsOptional()
  @IsIn(INVOICE_STATUSES, {
    message: `status must be one of: ${INVOICE_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
