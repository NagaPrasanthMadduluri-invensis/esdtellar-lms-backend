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
    required: ['heading', 'body', 'points'],
    properties: {
      heading: { type: 'string' },
      body: { type: 'string' },
      points: { type: 'array', items: { type: 'string' } },
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
  'Emphasise the words that carry the meaning, the key numbers, and the course,',
  'skill, department or badge names, by wrapping them in **double asterisks** for',
  'bold. Use bold sparingly, on the few words that matter in a point, never a',
  'whole sentence. Order the sections from most to least important. Every figure',
  'and every name must come from the context given; never invent one.',
].join('\n');
