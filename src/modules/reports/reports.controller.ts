import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import { ActivityService } from '@/modules/activity/activity.service';

import { AnalyticsService } from './analytics.service';
import { InsightsService } from './insights.service';
import type { BuiltReport } from './insights.service';
import { SpreadsheetService } from './spreadsheet.service';
import {
  ActivityQueryDto,
  AnalyticsQueryDto,
  ComparisonReportDto,
  GroupReportDto,
  IndividualReportDto,
} from './dto/insights.dto';
import type { Granularity } from './periods.util';

/**
 * Admin analytics. Every endpoint here is a read of the same per-learner
 * aggregate, so they all share AnalyticsService rather than each rebuilding it.
 */
@Controller('admin')
@Roles('admin')
export class ReportsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly insights: InsightsService,
    private readonly activity: ActivityService,
    private readonly spreadsheets: SpreadsheetService,
  ) {}

  @Get('dashboard')
  @Permissions('view_dashboard')
  async dashboard(@CurrentScope() scope: OrgScope) {
    return this.analytics.dashboard(scope);
  }

  @Get('reports')
  @Permissions('view_reports')
  async reports(@CurrentScope() scope: OrgScope) {
    return this.analytics.reports(scope);
  }

  /**
   * The dashboard's Action Required panel. Its own endpoint rather than a
   * field on `dashboard`: it is the slowest query on the page and the panel
   * sits below the fold, so the KPIs must not wait for it.
   */
  @Get('dashboard/action-required')
  @Permissions('view_dashboard')
  async actionRequired(@CurrentScope() scope: OrgScope) {
    return { items: await this.insights.actionRequired(scope) };
  }

  /** The dashboard's Recent Activity panel. */
  @Get('dashboard/activity')
  @Permissions('view_dashboard')
  async recentActivity(
    @CurrentScope() scope: OrgScope,
    @Query() query: ActivityQueryDto,
  ) {
    return this.activity.list(scope, query.limit ?? 8, query.offset ?? 0);
  }

  /**
   * The Analytics page — every series for one granularity, in one call.
   *
   * ONE endpoint rather than one per chart. The charts share a period axis and
   * an insight panel that compares them, so fetching them separately would let
   * the page render a quarterly axis against monthly bars for a frame, and the
   * server would rebuild the same axis eight times.
   */
  @Get('analytics')
  @Permissions('view_reports')
  async analyticsPage(
    @CurrentScope() scope: OrgScope,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.insights.analytics(
      scope,
      (query.granularity as Granularity) ?? 'monthly',
    );
  }

  /** Everything the Reports builder's controls need to render. */
  @Get('reports/options')
  @Permissions('view_reports')
  async reportOptions(@CurrentScope() scope: OrgScope) {
    return this.insights.reportOptions(scope);
  }

  /**
   * Building a report is a POST even though it writes nothing.
   *
   * A Comparison carries two arrays and a Group carries one plus four
   * filters; as a query string that is long enough to meet a proxy's URL cap,
   * and the arrays would have to be re-encoded by hand at every call site.
   * `@HttpCode(200)` keeps the response an OK rather than a 201, because
   * nothing was created.
   */
  @Post('reports/group')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async buildGroup(@CurrentScope() scope: OrgScope, @Body() dto: GroupReportDto) {
    return this.insights.buildGroup(scope, {
      types: dto.types as never,
      window: dto.window ?? 'all',
      filter: {
        department: dto.department ?? null,
        location: dto.location ?? null,
        jobRole: dto.job_role ?? null,
        jobLevel: dto.job_level ?? null,
      },
    });
  }

  @Post('reports/individual')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async buildIndividual(
    @CurrentScope() scope: OrgScope,
    @Body() dto: IndividualReportDto,
  ) {
    return this.insights.buildIndividual(scope, dto.user_id, dto.window ?? 'all');
  }

  @Post('reports/comparison')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async buildComparison(
    @CurrentScope() scope: OrgScope,
    @Body() dto: ComparisonReportDto,
  ) {
    return this.insights.buildComparison(scope, {
      dimension: dto.dimension,
      items: dto.items,
      metrics: dto.metrics,
      window: dto.window ?? 'all',
    });
  }

  /* ── The same three reports, as a downloadable .xlsx ─────────────────────
     Three routes rather than a `format` flag on the three above, because the
     response is a binary stream with its own headers and a `@Res()` handler —
     folding that into a route that usually returns JSON means one method with
     two contradictory return types and a Content-Type decided halfway down.

     Each rebuilds the report from the SAME spec the screen posted, through the
     same service. The file therefore says what the page said, except that the
     group export passes `full` so the table is not capped at ROW_CAP (§10.12).
     Exporting the on-screen rows instead would have handed over a file quietly
     truncated at 500 while its own summary described the whole population. */

  @Post('reports/group/export')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async exportGroup(
    @CurrentScope() scope: OrgScope,
    @Body() dto: GroupReportDto,
    @Res() response: Response,
  ): Promise<void> {
    const built = await this.insights.buildGroup(
      scope,
      {
        types: dto.types as never,
        window: dto.window ?? 'all',
        filter: {
          department: dto.department ?? null,
          location: dto.location ?? null,
          jobRole: dto.job_role ?? null,
          jobLevel: dto.job_level ?? null,
        },
      },
      true,
    );

    this.sendReport(response, 'Group report', built.window, built.reports);
  }

  @Post('reports/individual/export')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async exportIndividual(
    @CurrentScope() scope: OrgScope,
    @Body() dto: IndividualReportDto,
    @Res() response: Response,
  ): Promise<void> {
    const built = await this.insights.buildIndividual(
      scope,
      dto.user_id,
      dto.window ?? 'all',
    );

    // The person's details are on the page above the table, so they belong in
    // the file too — a spreadsheet headed only "Individual report" names
    // nobody.
    const person = built.person
      ? [
          { label: 'Learner', value: built.person.name },
          { label: 'Email', value: built.person.email },
          { label: 'Department', value: built.person.department ?? '—' },
          { label: 'Location', value: built.person.location ?? '—' },
          { label: 'Job role', value: built.person.job_role ?? '—' },
          { label: 'Job level', value: built.person.job_level ?? '—' },
        ]
      : undefined;

    this.sendReport(
      response,
      'Individual report',
      built.window,
      built.report ? [built.report] : [],
      person,
      built.person?.name,
    );
  }

  @Post('reports/comparison/export')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_reports')
  async exportComparison(
    @CurrentScope() scope: OrgScope,
    @Body() dto: ComparisonReportDto,
    @Res() response: Response,
  ): Promise<void> {
    const built = await this.insights.buildComparison(scope, {
      dimension: dto.dimension,
      items: dto.items,
      metrics: dto.metrics,
      window: dto.window ?? 'all',
    });

    this.sendReport(response, 'Comparison', built.window, built.reports);
  }

  /** Builds the workbook and names the file. Shared by the three above. */
  private sendReport(
    response: Response,
    heading: string,
    window: string,
    reports: BuiltReport[],
    person?: { label: string; value: string }[],
    subject?: string,
  ): void {
    const buffer = this.spreadsheets.buildInsightsWorkbook({
      heading,
      window,
      person,
      reports,
    });

    // The filename is what the admin sees in their downloads folder, and three
    // files called `report.xlsx` are indistinguishable there. Heading, who it
    // is about, and the date the file was taken.
    const parts = [
      'Edstellar',
      heading.replace(/\s+/g, '-'),
      subject?.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      new Date().toISOString().slice(0, 10),
    ].filter(Boolean);

    this.spreadsheets.send(response, buffer, `${parts.join('_')}.xlsx`);
  }

  @Get('departments')
  @Permissions('view_reports')
  async departments(@CurrentScope() scope: OrgScope) {
    return this.analytics.departments(scope);
  }

  @Get('leaderboard')
  @Permissions('view_reports')
  async leaderboard(@CurrentScope() scope: OrgScope) {
    return this.analytics.leaderboard(scope);
  }

  @Get('learning-hours')
  @Permissions('view_reports')
  async learningHours(@CurrentScope() scope: OrgScope) {
    return this.analytics.learningHours(scope);
  }

  @Get('export')
  @Permissions('view_reports')
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
