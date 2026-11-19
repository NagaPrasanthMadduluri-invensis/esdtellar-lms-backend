/**
 * Competency levels, catalogue-as-code — the same argument as
 * `common/course-taxonomy.ts`: a value means something only because something
 * reads it, and three things read these (the course-skill mapping, the upgrade
 * rule when a second course reinforces a skill, and the learner's own read).
 *
 * The order is the whole point: completing a higher-level course UPGRADES a
 * learner's competency and a lower-level one never downgrades it, so the levels
 * carry a rank. `GREATEST` over the text labels would order 'advanced' below
 * 'beginner' alphabetically, so the upgrade is computed from `levelRank`, not
 * the string.
 */
export const COMPETENCY_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;

export type CompetencyLevel = (typeof COMPETENCY_LEVELS)[number];

export const DEFAULT_COMPETENCY_LEVEL: CompetencyLevel = 'intermediate';

/** 1-based rank; an unknown value is treated as the lowest so it can never win an upgrade. */
export function levelRank(level: string | null | undefined): number {
  const i = COMPETENCY_LEVELS.indexOf(level as CompetencyLevel);
  return i < 0 ? 0 : i + 1;
}

export function isCompetencyLevel(value: unknown): value is CompetencyLevel {
  return (
    typeof value === 'string' &&
    (COMPETENCY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * A skill's stable key within its organization. Lower-cased, non-alphanumerics
 * collapsed to a single hyphen, trimmed — so "Project Management",
 * " project-management " and "Project  Management!" all resolve to the one slug,
 * which is what the `UNIQUE (organization_id, slug)` index is for.
 */
export function normalizeSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
