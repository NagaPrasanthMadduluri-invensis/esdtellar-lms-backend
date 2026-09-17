import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Put, Query,
} from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { SeatsService } from './seats.service';
import { RespondToSeatsDto, SetSeatLimitDto } from './dto/seats.dto';

/** Seats, from Edstellar's side. Setting a limit lives only here. */
@Controller('platform/seats')
@PlatformAdmin()
export class PlatformSeatsController {
  constructor(private readonly seats: SeatsService) {}

  @Get('requests')
  async list(@Query('status') status?: string) {
    return this.seats.listForPlatform(status);
  }

  /** Approving WRITES the tenant's seat limit — not just a status. */
  @Patch('requests/:id')
  async respond(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondToSeatsDto,
  ) {
    return this.seats.respond(id, dto);
  }

  /** Set a tenant's limit directly. `seat_limit: null` means unlimited. */
  @Put('organizations/:organizationId')
  async setLimit(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Body() dto: SetSeatLimitDto,
  ) {
    return this.seats.setLimit(organizationId, dto);
  }
}
