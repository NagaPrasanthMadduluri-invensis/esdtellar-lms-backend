/**
 * The clearly-structured EXPLANATION block shared by the learner coach and the
 * admin briefing (owner request 2026-11-19: "explain the things clearly —
 * heading, description, ordered points, bold where needed").
 *
 * The model must EXPLAIN, not just emit flat lists. Each section is a heading, a
 * short description and ordered points, and the points may carry **bold**
 * emphasis the one renderer (`components/shared/ai-sections.jsx`) turns into
 * real bold. Defining the format ONCE here means both prompts ask for exactly
 * the same shape, so a single component draws both and they cannot drift.
 */
export interface AiNarrativeSection {
  /** A short, specific heading (3 to 6 words). */
  heading: string;
  /** One or two sentences describing what this section is about. */
  body: string;
  /** Ordered, concrete points; key terms and numbers wrapped in **double asterisks**. */
  points: string[];
  /**
   * How this section should READ at a glance, so the UI can colour its border:
   * `critical` for a real danger (disruption, nobody meeting their hours, work
   * overdue), `positive` for genuine good news / momentum, `warning` for a
   * watch-out, `neutral` otherwise.
   */
  tone: 'critical' | 'warning' | 'positive' | 'neutral';
}

/**
 * The schema fragment for a `sections` array. Spread into a payload schema's
 * `properties` (and add `'sections'` to its `required`).
 */
export const NARRATIVE_SECTIONS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['heading', 'body', 'points', 'tone'],
    properties: {
      heading: { type: 'string' },
      body: { type: 'string' },
      points: { type: 'array', items: { type: 'string' } },
      tone: { type: 'string', enum: ['critical', 'warning', 'positive', 'neutral'] },
    },
  },
};

/**
 * The system-prompt block that tells the model how to write `sections`. Kept
 * here so the learner and admin prompts give identical formatting rules; each
 * prompt adds its own rules about WHICH facts to draw on.
 */
export const NARRATIVE_SECTIONS_INSTRUCTIONS = [
  'Lead the output with `sections`: 2 to 4 clearly-titled parts that EXPLAIN the',
  'situation in plain words, not just a list of fragments. Each section has:',
  '  - heading: a short, specific title (3 to 6 words), sentence case.',
  '  - body: one or two sentences describing what this section covers.',
  '  - points: 2 to 5 ordered, concrete, self-contained points.',
  '  - tone: how it should read at a glance. Use "critical" for a real danger',
  '    (disruption, nobody meeting their hours, overdue or failing work),',
  '    "positive" for genuine good news or momentum worth celebrating, "warning"',
  '    for a watch-out, and "neutral" otherwise. Be honest: do not call a problem',
  '    positive, and do not over-alarm.',
  'Emphasise the words that carry the meaning, the key numbers, and the course,',
  'skill, department or badge names, by wrapping them in **double asterisks** for',
  'bold. Use bold sparingly, on the few words that matter in a point, never a',
  'whole sentence. Order the sections from most to least important. Every figure',
  'and every name must come from the context given; never invent one.',
  'Write in a warm, professional and aspirational voice: motivating and',
  'forward-looking, celebrating real progress and framing next steps as',
  'opportunities, while staying specific, honest and concise. Inspire with',
  'substance, not hype.',
].join('\n');
