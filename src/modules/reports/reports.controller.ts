import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentScope, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import { AnalyticsService } from './analytics.service';
import { SpreadsheetService } from './spreadsheet.service';

/**
 * Admin analytics. Every endpoint here is a read of the same per-learner
 * aggregate, so they all share AnalyticsService rather than each rebuilding it.
 */
@Controller('admin')
@Roles('admin')
export class ReportsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly spreadsheets: SpreadsheetService,
  ) {}

  @Get('dashboard')
  async dashboard(@CurrentScope() scope: OrgScope) {
    return this.analytics.dashboard(scope);
  }

  @Get('reports')
  async reports(@CurrentScope() scope: OrgScope) {
    return this.analytics.reports(scope);
  }

  @Get('departments')
  async departments(@CurrentScope() scope: OrgScope) {
    return this.analytics.departments(scope);
  }

  @Get('leaderboard')
  async leaderboard(@CurrentScope() scope: OrgScope) {
    return this.analytics.leaderboard(scope);
  }

  @Get('learning-hours')
  async learningHours(@CurrentScope() scope: OrgScope) {
    return this.analytics.learningHours(scope);
  }

  @Get('export')
  async export(
    @CurrentScope() scope: OrgScope,
    @Res() response: Response,
  ): Promise<void> {
    const rows = await this.analytics.exportRows(scope);
    const buffer = this.spreadsheets.buildReportWorkbook(rows);
    const today = new Date().toISOString().slice(0, 10);
    this.spreadsheets.send(response, buffer, `Edstellar_LMS_Report_${today}.xlsx`);
  }
}
