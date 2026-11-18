import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { Public } from '@/common/decorators';
import { AlertsRepository } from '@/modules/alerts/alerts.repository';

/**
 * GET /api/health (§10.50). Public and cheap: one SELECT 1. 200 when the API
 * and its database answer, 503 when the database does not. Used by the
 * worker's watch, and suitable for an external uptime monitor. Says nothing
 * about versions or configuration.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly repo: AlertsRepository) {}

  @Public()
  @Get()
  async health() {
    let db = false;
    try {
      db = await this.repo.ping();
    } catch {
      db = false;
    }
    if (!db) throw new ServiceUnavailableException('Database is not answering.');
    return { ok: true };
  }
}
