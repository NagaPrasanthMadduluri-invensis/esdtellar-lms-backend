import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { MESSAGE_MAX_LENGTH } from '@/common/content-limits';

export class SendMessageDto {
  // Optional: a message may be an attachment with no text. The service requires
  // a body OR a file. (Multipart, so this arrives as a string field.)
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MESSAGE_MAX_LENGTH, {
    message: `A message must be ${MESSAGE_MAX_LENGTH} characters or fewer`,
  })
  body?: string;
}
