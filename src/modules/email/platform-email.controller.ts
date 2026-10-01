import { Controller, Get, Query } from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { EmailOutboxRepository } from './email-outbox.repository';
import { OutboxQueryDto } from './dto/email.dto';

/**
 * What the platform can see about mail that went out.
 *
 * Read-only, and `@PlatformAdmin()` rather than a tenant route: it spans
 * every organization by design, which is exactly why no tenant may reach it.
 *
 * This is not polish. Without it, every "did my learner actually get that
 * email?" is an SSH session and a hand-written query — and that question
 * arrives in week one, from support, about an address that bounced.
 */
@Controller('platform/email')
@PlatformAdmin()
export class PlatformEmailController {
  constructor(private readonly repository: EmailOutboxRepository) {}

  @Get('outbox')
  async outbox(@Query() query: OutboxQueryDto) {
    const { rows, total } = await this.repository.listForPlatform({
      status: query.status,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { rows, total };
  }

  /** The at-a-glance health figure: what has happened in the last day. */
  @Get('outbox/summary')
  async summary() {
    const counts = await this.repository.statusCounts(24);
    return {
      window_hours: 24,
      counts: Object.fromEntries(
        counts.map((c) => [c.status, Number(c.n)]),
      ) as Record<string, number>,
    };
  }
}
