import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentUser, PlatformAdmin } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import {
  CreateIncidentDto,
  IncidentNoteDto,
  NotifyClientsDto,
  UpdateIncidentDto,
} from './dto/incident.dto';
import { IncidentsService } from './incidents.service';

/**
 * The security incident register (0066), Edstellar's side only.
 *
 * `@PlatformAdmin()` at the class level (§5.2). There is deliberately no tenant
 * controller: a tenant learns of an incident through the notice it is sent,
 * and the register itself names other tenants. Integer ids, because these
 * screens carry no id in the browser URL (§10.34).
 */
@Controller('platform/incidents')
@PlatformAdmin()
export class PlatformIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  list() {
    return this.incidents.list();
  }

  /** The organizations an incident can name. Declared before :id. */
  @Get('options')
  options() {
    return this.incidents.options();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.incidents.get(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateIncidentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.incidents.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incidents.update(id, dto, user);
  }

  @Post(':id/notes')
  @HttpCode(201)
  addNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: IncidentNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incidents.addNote(id, dto.note, user);
  }

  /** Bell + email to every admin of every affected organization. 200: re-sendable. */
  @Post(':id/notify-clients')
  @HttpCode(200)
  notifyClients(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NotifyClientsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incidents.notifyClients(id, dto, user);
  }
}
