import * as XLSX from 'xlsx';

import type { SessionsService } from './sessions.service';

type Report = Awaited<ReturnType<SessionsService['sessionReport']>>;

/** "3h 30m", "45m", or "" when unknown. */
export function formatMinutes(min: number | null | undefined): string {
  if (!min || min <= 0) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

const STATUS: Record<string, string> = {
  present: 'Present', late: 'Late', partial: 'Partial', absent: 'Absent', excused: 'Excused',
};

/**
 * The Download Session Report workbook (0074). Four sheets drawn from the one
 * `sessionReport` payload the printable PDF also uses: Summary, Batches and
 * schedule, Learners (with batch, attendance and feedback), Feedback.
 */
export function buildSessionReportXlsx(r: Report): Buffer {
  const wb = XLSX.utils.book_new();
  const t = r.totals;

  const summary = [
    ['Session report'],
    [],
    ['Session', r.session.title],
    ['Format', r.session.type],
    ['Trainer', r.session.trainer],
    ['Venue or link', r.session.venue],
    ['Status', r.session.status],
    ['Enrolment', r.session.enrollMode === 'self' ? 'Self enrolment' : 'Admin assigned'],
    ['First day', r.session.firstDate ?? ''],
    ['Last day', r.session.lastDate ?? ''],
    [],
    ['Total learners', t.learners],
    ['Batches', t.batches || 'Single sitting'],
    ['Total capacity', t.capacity],
    ['Registered', t.registered],
    ['Seats available', t.available],
    ['On waitlist', t.waitlist],
    ['Scheduled duration (all sittings)', formatMinutes(t.scheduledMinutes)],
    [],
    ['Attendance: present', t.attendance.present],
    ['Attendance: late', t.attendance.late],
    ['Attendance: partial', t.attendance.partial],
    ['Attendance: absent', t.attendance.absent],
    ['Attendance: excused', t.attendance.excused],
    ['Attendance: not marked', t.attendance.unmarked],
    ['Attendance rate (of marked)', t.attendanceRatePct === null ? '' : `${t.attendanceRatePct}%`],
    [],
    ['Feedback responses', r.feedbackSummary.count],
    ['Average: content', r.feedbackSummary.content ?? ''],
    ['Average: trainer', r.feedbackSummary.trainer ?? ''],
    ['Average: delivery', r.feedbackSummary.delivery ?? ''],
    ['Average: overall (out of 5)', r.feedbackSummary.overall ?? ''],
    [],
    ['Generated', r.generatedAt],
  ];
  const s1 = XLSX.utils.aoa_to_sheet(summary);
  s1['!cols'] = [{ wch: 34 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, s1, 'Summary');

  const sittings = [
    ['Batch', 'Status', 'Start date', 'End date', 'Days', 'Start time', 'End time', 'Duration', 'Trainer', 'Capacity', 'Registered', 'Available', 'Waitlist'],
    ...r.sittings.map((x) => [
      x.name, x.status, x.start_date ?? 'Date to be set', x.end_date ?? '', x.dates.length,
      x.start_time ?? '', x.end_time ?? '', formatMinutes(x.total_minutes), x.trainer_name ?? '',
      x.capacity, x.registered, x.available, x.waitlist,
    ]),
  ];
  const s2 = XLSX.utils.aoa_to_sheet(sittings);
  s2['!cols'] = [24, 11, 12, 12, 6, 10, 10, 10, 22, 9, 10, 9, 8].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, s2, 'Batches and schedule');

  const learners = [
    ['Name', 'Email', 'Department', 'Job role', 'Batch', 'Registered on', 'Attendance', 'Join time', 'Notes', 'Content', 'Trainer', 'Delivery', 'Average', 'Comment'],
    ...r.learners.map((l) => [
      l.name, l.email, l.department ?? '', l.jobRole ?? '', l.batch, (l.enrolledAt ?? '').slice(0, 10),
      l.attendance ? STATUS[l.attendance] ?? l.attendance : 'Not marked', l.joinTime ?? '', l.notes ?? '',
      l.feedback?.content ?? '', l.feedback?.trainer ?? '', l.feedback?.delivery ?? '', l.feedback?.average ?? '',
      l.feedback?.comment ?? '',
    ]),
  ];
  const s3 = XLSX.utils.aoa_to_sheet(learners);
  s3['!cols'] = [22, 30, 16, 20, 22, 12, 12, 10, 24, 8, 8, 8, 8, 40].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, s3, 'Learners');

  const withFeedback = r.learners.filter((l) => l.feedback);
  const feedback = [
    ['Name', 'Email', 'Batch', 'Content', 'Trainer', 'Delivery', 'Average', 'Comment', 'Submitted'],
    ...withFeedback.map((l) => [
      l.name, l.email, l.batch, l.feedback!.content, l.feedback!.trainer, l.feedback!.delivery,
      l.feedback!.average, l.feedback!.comment ?? '', (l.feedback!.submittedAt ?? '').slice(0, 10),
    ]),
  ];
  const s4 = XLSX.utils.aoa_to_sheet(feedback);
  s4['!cols'] = [22, 30, 22, 8, 8, 8, 8, 50, 12].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, s4, 'Feedback');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A safe download name: "session-report-negotiation-lab-2026-12-01.xlsx". */
export function reportFilename(title: string, date: string | null): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'session';
  return `session-report-${slug}${date ? `-${date}` : ''}.xlsx`;
}
