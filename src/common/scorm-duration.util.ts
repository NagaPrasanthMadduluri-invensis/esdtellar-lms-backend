/**
 * Parses a SCORM `total_time` into minutes.
 *
 * The two SCORM versions use DIFFERENT formats, and only handling one of them
 * silently reports zero learning time for every package of the other kind:
 *
 *   SCORM 2004  cmi.total_time       ISO 8601 duration   "PT1H30M45S"
 *   SCORM 1.2   cmi.core.total_time  CMITimespan         "0001:30:45.00"
 *
 * The 1.2 form is `HHHH:MM:SS.SS`, where the hours field is not capped at 24.
 * Anything unrecognised returns 0 rather than throwing, because a malformed
 * time from one package must not break a whole learning-hours report.
 */
export function parseScormDuration(raw: string | null): number {
  if (!raw) return 0;
  const value = raw.trim();
  if (!value) return 0;

  // SCORM 1.2 — HHHH:MM:SS(.SS)
  const timespan = value.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (timespan) {
    return (
      parseFloat(timespan[1]) * 60 +
      parseFloat(timespan[2]) +
      parseFloat(timespan[3]) / 60
    );
  }

  // SCORM 2004 — ISO 8601 duration. Days are permitted by the spec (P1DT2H).
  const iso = value.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (iso && value.toUpperCase() !== 'P') {
    const [, , , days, hours, minutes, seconds] = iso;
    return (
      parseFloat(days || '0') * 24 * 60 +
      parseFloat(hours || '0') * 60 +
      parseFloat(minutes || '0') +
      parseFloat(seconds || '0') / 60
    );
  }

  return 0;
}

