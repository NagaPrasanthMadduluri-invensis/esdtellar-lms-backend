/**
 * Extracts the per-question record from a CMI snapshot.
 *
 * SCORM reports questions as `cmi.interactions.N.*`. Whether they appear at all
 * is up to the authoring tool — Storyline and Captivate normally emit them, a
 * hand-rolled package often emits none. So this returns an empty array rather
 * than throwing, and the caller is expected to tell the admin that the package
 * reports no question data instead of showing an empty table.
 *
 * The two SCORM versions disagree on names, and scorm-again may hand back
 * either an array or an object keyed by index, so every shape is normalised
 * here rather than at the call site.
 */

export interface ScormInteraction {
  index: number;
  /** The question identifier the package assigned. */
  id: string | null;
  /** choice | true-false | fill-in | matching | numeric | … */
  type: string | null;
  description: string | null;
  learnerResponse: string | null;
  correctResponse: string | null;
  /** correct | incorrect | neutral | a numeric score, per the spec. */
  result: string | null;
  /** True/false/null — null when `result` is not a pass/fail verdict. */
  isCorrect: boolean | null;
  weighting: number | null;
  latency: string | null;
  timestamp: string | null;
}

type Unknown = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * `correct_responses` is itself a list (`{ pattern }` per entry), because a
 * question can accept more than one right answer.
 */
function correctResponse(raw: unknown): string | null {
  const list = toArray(raw);
  const patterns = list
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : asString((entry as Unknown)?.pattern),
    )
    .filter((p): p is string => Boolean(p));

  return patterns.length > 0 ? patterns.join(', ') : null;
}

/** Accepts an array, or an object keyed "0", "1", … and returns an array. */
function toArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Unknown)
      // Ignore bookkeeping keys such as `_count` / `_children`.
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value);
  }
  return [];
}

function verdict(result: string | null): boolean | null {
  if (!result) return null;
  const normalised = result.toLowerCase();
  if (normalised === 'correct') return true;
  if (normalised === 'incorrect' || normalised === 'wrong') return false;
  return null; // "neutral", or a raw numeric score
}

export function parseInteractions(cmiJson: string | null): ScormInteraction[] {
  if (!cmiJson) return [];

  let cmi: Unknown;
  try {
    cmi = JSON.parse(cmiJson) as Unknown;
  } catch {
    return [];
  }

  // Some payloads nest everything under `cmi`, others are already the cmi body.
  const root = ((cmi.cmi as Unknown) ?? cmi) as Unknown;
  const raw = toArray(root.interactions);

  return raw.map((entry, index) => {
    const item = (entry ?? {}) as Unknown;
    const result = asString(item.result);

    return {
      index,
      id: asString(item.id),
      type: asString(item.type),
      description: asString(item.description),
      // 1.2 calls it student_response, 2004 learner_response.
      learnerResponse:
        asString(item.learner_response) ?? asString(item.student_response),
      correctResponse: correctResponse(item.correct_responses),
      result,
      isCorrect: verdict(result),
      weighting: asNumber(item.weighting),
      latency: asString(item.latency),
      timestamp: asString(item.timestamp) ?? asString(item.time),
    };
  });
}
