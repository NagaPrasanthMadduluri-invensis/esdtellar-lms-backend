/**
 * The Edstellar services catalogue — the SERVER's half.
 *
 * Seventh catalogue-as-code here, after permissions, badges, workforce,
 * course-taxonomy, lesson-content and assessment-questions. Same argument as
 * every one of those: a value means something only because something reads it,
 * and here the reader is a validator — a request naming a service Edstellar
 * does not offer is refused with a 422 listing what it does.
 *
 * DELIBERATELY ONLY THE NAMES. The browser's mirror
 * (`client/lib/edstellar-services.js`) carries the same 42 names plus the
 * grouping, the descriptions and the per-service question sets, which together
 * run to ~70KB. None of that is enforceable: the grouping is navigation, the
 * descriptions are copy, and the questions vary per service while the answers
 * are stored as one JSON blob either way. Copying it here would double the
 * maintenance and validate nothing.
 *
 * What IS enforced is the name, because that is the field a human at Edstellar
 * routes the request by. Adding a service means editing both files; if they
 * drift, the browser offers something the API refuses by name — loud, not
 * silent.
 */

export const SERVICE_NAMES = [
  "Training Needs Analysis (TNA)",
  "Learning Strategy & Design",
  "Competency Framework Design",
  "Content Development",
  "Learning Technology Advisory",
  "Organisational Development (OD)",
  "Culture Transformation",
  "Change Management",
  "Team Effectiveness",
  "Succession Planning",
  "Psychometric Assessment",
  "Leadership Assessment",
  "MBTI",
  "DISC Assessment",
  "360\u00b0 Feedback",
  "Competency Assessment",
  "Assessment Centre",
  "Digital & Technology Skills",
  "Finance for Non-Finance",
  "Sales & Business Development",
  "Project Management",
  "POSH / Prevention of Harassment",
  "Safety & HSE Training",
  "Data Privacy (GDPR / DPDP)",
  "Ethics & Code of Conduct",
  "First-Time Manager Programme",
  "Leadership Development",
  "Coaching Skills for Managers",
  "Hi-Po / Succession Development",
  "Communication & Presentation",
  "Customer Service Excellence",
  "Negotiation & Influencing",
  "Emotional Intelligence (EQ)",
  "Skills Intelligence Platform (SIP)",
  "TNA / TNI Engine",
  "Assessment & LMS Tooling",
  "Custom LMS Implementation",
  "Capability Transformation",
  "Blended / On-the-Job Learning",
  "Imperium \u2014 Executive Retreats",
  "Polaris \u2014 Team Alignment",
  "Invensis Learning \u2014 Certifications",
];

export type ServiceName = (typeof SERVICE_NAMES)[number];

export function isServiceName(value: string): boolean {
  return SERVICE_NAMES.includes(value);
}

/**
 * Where a request has got to. Stored as text, not an enum type: these are
 * workflow labels an account manager moves through, and adding a fifth must
 * not need a migration.
 */
export const REQUEST_STATUSES = [
  'pending',
  'in_discussion',
  'proposal_sent',
  'closed',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];
