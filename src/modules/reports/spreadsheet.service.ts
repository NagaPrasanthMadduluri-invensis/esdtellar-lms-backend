import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Cell = string | number | null;

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
