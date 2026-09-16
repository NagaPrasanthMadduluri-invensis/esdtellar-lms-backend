import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Cell = string | number | null;

/**
 * Excel refuses a sheet name over 31 characters or containing any of
 * `[]:*?/\\`, and refuses a workbook with two sheets of the same name — so a
 * report title goes through here rather than straight onto the tab. Both
 * happen with real data: "Individual report — Priya Raghunathan" is 38
 * characters, and a comparison can produce two sections whose titles differ
 * only past the cut.
 */
function sheetName(title: string, workbook: XLSX.WorkBook): string {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Report';
  if (!workbook.SheetNames.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = ` (${n})`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!workbook.SheetNames.includes(candidate)) return candidate;
  }
  return base.slice(0, 28) + '...';
}

/**
 * Builds and streams .xlsx files. Isolated from the analytics query layer so
 * the reporting endpoints stay about data and this stays about presentation.
 */
@Injectable()
export class SpreadsheetService {
  /** Writes a workbook buffer to the response with download headers. */
  send(response: Response, buffer: Buffer, filename: string): void {
    response
      .status(200)
      .setHeader('Content-Type', XLSX_MIME)
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      // Without this the browser hides Content-Disposition from the page's own
      // JavaScript — CORS exposes only a handful of headers by default, and
      // the API is a different origin from the UI. The server was naming every
      // file carefully and the fetch that saved it could not read the name, so
      // downloads landed under whatever fallback the caller had hardcoded.
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .send(buffer);
  }

  buildLearnerUploadTemplate(): Buffer {
    const workbook = XLSX.utils.book_new();

    const sheet = XLSX.utils.aoa_to_sheet([
      [
        '⚠ Instructions: Fill in one learner per row. Password column is optional — leave blank to use default password: Edstellar@123',
        '', '', '', '', '', '', '',
      ],
      ['Employee ID', 'First Name', 'Last Name', 'Email', 'Department', 'Location', 'Job Role', 'Password'],
      ['EMP-001', 'Alice', 'Johnson', 'alice@company.com', 'Engineering', 'Bangalore', 'Software Engineer', ''],
      ['EMP-002', 'Bob', 'Smith', 'bob@company.com', 'Sales', 'Mumbai', 'Sales Manager', ''],
      ['EMP-003', 'Carol', 'Williams', 'carol@company.com', 'HR', 'Delhi', 'HR Coordinator', ''],
    ]);

    sheet['!cols'] = [
      { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 32 },
      { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 20 },
    ];
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];

    XLSX.utils.book_append_sheet(workbook, sheet, 'Learner Upload');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  buildReportWorkbook(input: {
    progressRows: Cell[][];
    deptRows: Cell[][];
    leaderRows: Cell[][];
    assignRows: Cell[][];
  }): Buffer {
    const workbook = XLSX.utils.book_new();

    this.appendSheet(
      workbook,
      'Learner Progress Report',
      'EDSTELLAR LMS — LEARNER PROGRESS REPORT',
      ['#', 'Employee ID', 'Full Name', 'Department', 'Manager', 'Email',
       'Course Name', 'Assigned On', 'Due Date', 'Status', 'Progress %',
       'Assessment Score', 'Pass / Fail', 'Time Spent'],
      input.progressRows,
      [4, 10, 22, 16, 18, 28, 38, 14, 12, 14, 12, 16, 12, 12],
    );

    this.appendSheet(
      workbook,
      'Department Analytics',
      'DEPARTMENT-WISE TRAINING ANALYTICS',
      ['Department', 'Manager', 'Total Learners', 'Completed', 'In Progress',
       'Not Started / Failed', 'Completion Rate %', 'Avg Score %'],
      input.deptRows,
      [20, 18, 15, 12, 14, 20, 18, 12],
    );

    this.appendSheet(
      workbook,
      'Leaderboard & Top Scorers',
      'ASSESSMENT LEADERBOARD',
      ['Rank', 'Employee ID', 'Name', 'Department', 'Score %', 'Grade'],
      input.leaderRows,
      [6, 12, 24, 18, 10, 8],
    );

    this.appendSheet(
      workbook,
      'Assignment Tracker',
      'COURSE ASSIGNMENT & COMPLIANCE TRACKER',
      ['Employee ID', 'Full Name', 'Department', 'Manager', 'Course Assigned',
       'Assigned On', 'Due Date', 'Status', 'Days Overdue / Remaining'],
      input.assignRows,
      [12, 22, 16, 18, 38, 14, 12, 14, 22],
    );

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  /**
   * The Reports builder's output as a workbook — one sheet per report section,
   * so a Group report covering three types downloads as three tabs rather than
   * three tables stacked in one.
   *
   * Each sheet carries the same three blocks the screen shows, in the same
   * order: the title and window, the KPI summary, then the table. Somebody
   * reading the file a month later needs to know what was asked for, not just
   * what came back — a bare grid of numbers with no window on it cannot be
   * checked against anything.
   */
  buildInsightsWorkbook(input: {
    heading: string;
    window: string;
    person?: { label: string; value: string }[];
    reports: {
      key: string;
      title: string;
      kpis: { label: string; value: string }[];
      columns: string[];
      rows: (string | number)[][];
    }[];
  }): Buffer {
    const workbook = XLSX.utils.book_new();

    for (const report of input.reports) {
      const aoa: Cell[][] = [
        [report.title],
        [`${input.heading} · ${input.window}`],
        [`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`],
        [],
      ];

      if (input.person?.length) {
        for (const field of input.person) aoa.push([field.label, field.value]);
        aoa.push([]);
      }

      aoa.push(['SUMMARY']);
      for (const kpi of report.kpis) aoa.push([kpi.label, kpi.value]);
      aoa.push([]);

      aoa.push(report.columns);
      for (const row of report.rows) aoa.push([...row]);

      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      sheet['!cols'] = report.columns.map((header, i) => ({
        // Widen to whatever the widest cell in the column actually is, within
        // reason. A fixed width truncates a course name and leaves a date
        // column three times wider than it needs to be.
        wch: Math.min(
          48,
          Math.max(
            12,
            header.length + 2,
            ...report.rows.map((r) => String(r[i] ?? '').length + 2),
          ),
        ),
      }));

      XLSX.utils.book_append_sheet(workbook, sheet, sheetName(report.title, workbook));
    }

    // A workbook with no sheet is not a valid .xlsx, and "no report matched"
    // must arrive as a readable file rather than a corrupt download.
    if (input.reports.length === 0) {
      const sheet = XLSX.utils.aoa_to_sheet([
        [input.heading],
        [input.window],
        [],
        ['That selection produced no report. Widen the time period or clear a filter.'],
      ]);
      sheet['!cols'] = [{ wch: 76 }];
      XLSX.utils.book_append_sheet(workbook, sheet, 'No results');
    }

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  private appendSheet(
    workbook: XLSX.WorkBook,
    name: string,
    title: string,
    headers: string[],
    rows: Cell[][],
    widths: number[],
  ): void {
    const sheet = XLSX.utils.aoa_to_sheet([[title], headers, ...rows]);
    sheet['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
}
