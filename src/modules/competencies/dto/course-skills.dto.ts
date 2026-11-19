import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';

import { COMPETENCY_LEVELS } from '@/common/competencies';

export class CourseSkillItemDto {
  @IsInt()
  @Min(1)
  skillId!: number;

  @IsIn(COMPETENCY_LEVELS as unknown as string[])
  level!: string;
}

export class SetCourseSkillsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CourseSkillItemDto)
  skills!: CourseSkillItemDto[];
}

export class ListSkillsQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  archived?: string;
}
