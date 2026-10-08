import { Injectable, PipeTransform } from '@nestjs/common';

import { PublicIdService } from './public-id.service';

/**
 * Resolve a `:courseId` URL param (now the course's public UUID, 0046) to the
 * integer id, accepting a legacy integer too. A pipe rather than an inline
 * `resolveIdOrThrow` call because the admin courses controller has ten routes
 * taking `:courseId`, and a one-token `ParseIntPipe -> CourseIdPipe` swap on
 * each is far less error-prone than rewriting ten handler bodies. Nest
 * instantiates it through DI (PublicIdService is global) and awaits the async
 * transform.
 */
@Injectable()
export class CourseIdPipe implements PipeTransform<string, Promise<number>> {
  constructor(private readonly publicId: PublicIdService) {}

  transform(value: string): Promise<number> {
    return this.publicId.resolveIdOrThrow('courses', value);
  }
}
