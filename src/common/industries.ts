/**
 * The industries a tenant can be filed under.
 *
 * This one genuinely IS a closed code catalogue, unlike the branch locations
 * and job levels that moved into per-organization tables in `0031`. The
 * difference is who the value describes: a branch location is a fact about
 * one customer's offices and only they know it, while an industry is how
 * EDSTELLAR segments its own customer base. A list only Edstellar writes,
 * read across every tenant to compare them, belongs in code beside the
 * screens that render it.
 *
 * Kept deliberately coarse. Thirty sectors would make the directory's filter
 * useless for the reason `job_role` is useless as a dimension: values that do
 * not repeat compare nothing.
 */
export const INDUSTRIES = [
  'Banking & Financial Services',
  'Insurance',
  'IT Services',
  'Software & Product',
  'Telecom',
  'Manufacturing',
  'Automotive',
  'Pharmaceuticals & Life Sciences',
  'Healthcare',
  'Retail & E-commerce',
  'Logistics & Supply Chain',
  'Energy & Utilities',
  'Construction & Real Estate',
  'Media & Entertainment',
  'Education',
  'Hospitality & Travel',
  'Professional Services',
  'Public Sector',
  'Non-profit',
  'Other',
] as const;

export type Industry = (typeof INDUSTRIES)[number];
