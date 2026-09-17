import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe,
  Patch, Post, Query,
} from '@nestjs/common';

import { CurrentUser, PlatformAdmin } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { BillingService } from './billing.service';
import {
  CreateInvoiceDto, ListInvoicesDto, RecordPaymentDto, UpdateInvoiceDto,
} from './dto/invoice.dto';

/**
 * Invoices and payments. PLATFORM ONLY.
 *
 * There is deliberately no tenant-facing counterpart. A customer seeing its
 * own invoices is a reasonable feature, but it is a separate decision about
 * what they may see and do — and building it by widening these routes would
 * hand a tenant the ability to record its own payments.
 */
@Controller('platform/billing')
@PlatformAdmin()
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('invoices')
  async list(@Query() query: ListInvoicesDto) {
    return this.billing.list(query);
  }

  @Get('invoices/:id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.billing.get(id);
  }

  @Post('invoices')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateInvoiceDto) {
    return this.billing.create(dto);
  }

  @Patch('invoices/:id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.billing.update(id, dto);
  }

  @Delete('invoices/:id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.billing.remove(id);
  }

  /** Record money that arrived. Refused on a draft, a void, or an overpayment. */
  @Post('invoices/:id/payments')
  @HttpCode(HttpStatus.CREATED)
  async pay(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.billing.recordPayment(id, dto, admin.userId);
  }

  @Delete('invoices/:id/payments/:paymentId')
  async unpay(
    @Param('id', ParseIntPipe) id: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
  ) {
    return this.billing.removePayment(id, paymentId);
  }
}
