import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Both filters are optional; omitting them lists every certificate. */
export class ListCertificatesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'userId must be an integer' })
  @Min(1)
  userId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'courseId must be an integer' })
  @Min(1)
  courseId?: number;
}
