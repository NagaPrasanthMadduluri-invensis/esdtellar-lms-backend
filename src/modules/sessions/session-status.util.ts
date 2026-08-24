/**
 * The status a session is *shown* with, as opposed to the one stored.
 *
 * `sessions.status` records only what a human decided: it is created
 * `upcoming`, an admin cancels it, and an admin marks it completed. "In
 * progress" is not a decision anyone makes — it is simply what is true once the
 * clock passes the scheduled start — so it is derived on read rather than
 * stored. That way there is no scheduler to run, nothing to drift if the
 * process is down at the moment a session begins, and no fifth value in the
 * column for the admin form to have to round-trip.
 *
 * A session whose end time has passed without being marked completed keeps
 * reading `in_progress`, deliberately: completion is the admin's to trigger
 * (it is what credits attendance, hours and completion metrics), so the state
 * should keep saying it is outstanding rather than quietly close itself.
 */
export type SessionDisplayStatus =
  | 'upcoming'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface SchedulableSession {
  status?: string | null;
  date?: string | null;
  start_time?: string | null;
}

/**
 * `date` is `YYYY-MM-DD` and `start_time` is `HH:MM` (or `HH:MM:SS`), both in
 * the deployment's local time — the same values the calendar renders — so they
 * are read as local rather than UTC.
 */
function startsAt(date: string, startTime: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = startTime.split(':').map(Number);
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function displayStatus(
  session: SchedulableSession,
  now: Date = new Date(),
): SessionDisplayStatus {
  const stored = session.status ?? 'upcoming';

  // A decision already made outranks the clock.
  if (stored === 'completed' || stored === 'cancelled') return stored;

  const start =
    session.date && session.start_time
      ? startsAt(session.date, session.start_time)
      : null;

  // Unparseable schedule: report what is stored rather than guess a state.
  if (!start) return 'upcoming';

  return now >= start ? 'in_progress' : 'upcoming';
}
