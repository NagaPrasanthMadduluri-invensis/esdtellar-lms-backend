import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { Roles } from '@/common/decorators';
import { SpreadsheetService } from '@/modules/reports/spreadsheet.service';

import {
  BulkCreateUsersDto,
  CreateUserDto,
  ToggleActiveDto,
  UpdateUserDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('admin/users')
@Roles('admin')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly spreadsheets: SpreadsheetService,
  ) {}

  @Get()
  async list() {
    return this.users.listLearners();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  /**
   * Declared BEFORE `:userId`. Nest matches routes in declaration order, so a
   * literal segment listed after a parameter segment would be swallowed by it
   * (`:userId` would capture "template").
   */
  @Get('template')
  template(@Res() response: Response): void {
    const buffer = this.spreadsheets.buildLearnerUploadTemplate();
    this.spreadsheets.send(response, buffer, 'Learner_Upload_Template.xlsx');
  }

  @Post('bulk')
  async bulk(@Body() dto: BulkCreateUsersDto, @Res() response: Response) {
    const result = await this.users.bulkCreate(dto);
    // Preserves the legacy contract: 201 when anything was created, otherwise
    // 422 to signal that the whole upload failed validation.
    response
      .status(result.created > 0 ? HttpStatus.CREATED : HttpStatus.UNPROCESSABLE_ENTITY)
      .json(result);
  }

  @Get(':userId')
  async detail(@Param('userId', ParseIntPipe) userId: number) {
    return this.users.getLearnerDetail(userId);
  }

  @Put(':userId')
  async update(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(userId, dto);
  }

  @Patch(':userId')
  async toggle(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ToggleActiveDto,
  ) {
    return this.users.setActive(userId, dto.is_active);
  }

  @Delete(':userId')
  async remove(@Param('userId', ParseIntPipe) userId: number) {
    return this.users.remove(userId);
  }
}

/** `/api/admin/employees` — the same learners, enriched with progress. */
@Controller('admin/employees')
@Roles('admin')
export class EmployeesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list() {
    return this.users.listEmployees();
  }
}
