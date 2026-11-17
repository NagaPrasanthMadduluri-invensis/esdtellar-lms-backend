/**
 * Security incident vocabulary and the deadline clocks (0066).
 *
 * `client/lib/incidents.js` mirrors the LABELS only. The browser never
 * computes a deadline: `incidentDeadlines()` runs here and the API sends the
 * result, so the register and any future alert cannot disagree about whether
 * something is overdue.
 *
 * The clocks (Spectra-LMS-Privacy-Pack doc 10 explains each):
 *
 * | Clock | Starts | Length | Applies |
 * |---|---|---|---|
 * | Assessment | discovery | 30 days (PDPC expectation; aim sooner) | always |
 * | Tell clients | discovery | 24 hours (our processor target, to be aligned with the DPA) | when an organization is affected |
 * | Regulator, GDPR / DPDP | discovery (awareness) | 72 hours | unless assessed not notifiable |
 * | Regulator, PDPA | the assessment | 3 calendar days | when assessed notifiable |
 * | Individuals | | as soon as practicable | when assessed notifiable |
 *
 * Edstellar is mostly the PROCESSOR: for client data the regulator and
 * individual notices are the client's duty, which Edstellar supports and
 * records. For its own staff data it is the controller.
 */

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const INCIDENT_STATUSES = ['open', 'assessing', 'contained', 'closed'] as const;
export const INCIDENT_ASSESSMENTS = ['undecided', 'notifiable', 'not_notifiable'] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentAssessment = (typeof INCIDENT_ASSESSMENTS)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Processor notice target. A proposal: align it with the client DPA. */
export const CLIENT_NOTICE_HOURS = 24;
export const ASSESSMENT_DAYS = 30;
export const REGULATOR_AWARENESS_HOURS = 72;
export const PDPA_NOTICE_DAYS = 3;
/** A clock inside this window reads "due soon". */
export const DUE_SOON_HOURS = 24;

export type DeadlineState = 'done' | 'overdue' | 'due_soon' | 'pending';

export interface IncidentDeadline {
  key: 'assessment' | 'clients' | 'regulator_72h' | 'regulator_pdpa' | 'individuals';
  label: string;
  /** null when the law sets no fixed time ("as soon as practicable"). */
  due_at: string | null;
  done_at: string | null;
  state: DeadlineState;
  basis: string;
}

export interface IncidentClockInput {
  discovered_at: string;
  assessment: string;
  assessed_at: string | null;
  clients_notified_at: string | null;
  regulator_notified_at: string | null;
  individuals_notified_at: string | null;
  affected_organizations: number;
}

/** Parse a Postgres or ISO timestamp (a `+00` offset is repaired). */
export function toTime(value: string | Date | null): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

function stateOf(due: number | null, done: number | null, now: number): DeadlineState {
  if (done !== null) return 'done';
  if (due === null) return 'pending';
  if (now > due) return 'overdue';
  if (due - now <= DUE_SOON_HOURS * HOUR) return 'due_soon';
  return 'pending';
}

/** Every clock that applies to this incident, in the order they fall due. */
export function incidentDeadlines(i: IncidentClockInput, now = Date.now()): IncidentDeadline[] {
  const discovered = toTime(i.discovered_at) ?? now;
  const assessed = toTime(i.assessed_at);
  const out: IncidentDeadline[] = [];
  const push = (
    key: IncidentDeadline['key'],
    label: string,
    due: number | null,
    doneAt: string | null,
    basis: string,
  ) => {
    const done = toTime(doneAt);
    out.push({ key, label, due_at: iso(due), done_at: iso(done), state: stateOf(due, done, now), basis });
  };

  push(
    'assessment',
    'Assess whether it is notifiable',
    discovered + ASSESSMENT_DAYS * DAY,
    i.assessment === 'undecided' ? null : i.assessed_at ?? i.discovered_at,
    'PDPC expects an assessment within 30 days of discovery. Aim for days, not weeks.',
  );

  if (i.affected_organizations > 0) {
    push(
      'clients',
      'Tell the affected client organizations',
      discovered + CLIENT_NOTICE_HOURS * HOUR,
      i.clients_notified_at,
      'As their processor, without undue delay. 24 hours is our target; the client contract may set another.',
    );
  }

  if (i.assessment !== 'not_notifiable') {
    push(
      'regulator_72h',
      'Regulator: GDPR and India DPDP report',
      discovered + REGULATOR_AWARENESS_HOURS * HOUR,
      i.regulator_notified_at,
      'GDPR: 72 hours from awareness. DPDP Rules: intimation without delay, detailed report within 72 hours. Usually the client (controller) files it, with our support.',
    );
  }

  if (i.assessment === 'notifiable') {
    push(
      'regulator_pdpa',
      'Regulator: Singapore PDPC',
      (assessed ?? discovered) + PDPA_NOTICE_DAYS * DAY,
      i.regulator_notified_at,
      'PDPA: within 3 calendar days of assessing the breach as notifiable.',
    );
    push(
      'individuals',
      'Tell the affected individuals',
      null,
      i.individuals_notified_at,
      'As soon as practicable (PDPA: on or after notifying PDPC). DPDP: every affected person.',
    );
  }

  return out.sort((a, b) => {
    if (a.due_at === null) return 1;
    if (b.due_at === null) return -1;
    return a.due_at.localeCompare(b.due_at);
  });
}

/** The single most urgent open clock, for the list row. */
export function nextDeadline(deadlines: IncidentDeadline[]): IncidentDeadline | null {
  const open = deadlines.filter((d) => d.state !== 'done');
  return open.find((d) => d.state === 'overdue') ?? open[0] ?? null;
}
