import { Module } from '@nestjs/common';

import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { PlatformBillingController } from './platform-billing.controller';

/**
 * Exports the SERVICE only (§3.2) — the platform overview injects it to put
 * money beside each tenant's usage, and must not reach the repository.
 */
@Module({
  controllers: [PlatformBillingController],
  providers: [BillingService, BillingRepository],
  exports: [BillingService],
})
export class BillingModule {}
