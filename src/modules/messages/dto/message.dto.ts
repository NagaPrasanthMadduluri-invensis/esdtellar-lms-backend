import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { MESSAGE_MAX_LENGTH } from '@/common/content-limits';

export class SendMessageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'A message cannot be empty' })
  @MaxLength(MESSAGE_MAX_LENGTH, {
    message: `A message must be ${MESSAGE_MAX_LENGTH} characters or fewer`,
  })
  body!: string;
}
