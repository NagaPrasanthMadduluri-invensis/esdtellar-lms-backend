/**
 * Seed data for a FRESH database.
 *
 * Relocated verbatim from the old client/lib/db/schema.js — the server owns the
 * database, so its seed data lives here too. Kept as a standalone .mjs script
 * rather than compiled TypeScript because it is a one-shot data loader, not
 * application code: it never runs in the request path.
 *
 * Table creation is NOT done here — that is src/database/migrations/0000_baseline_schema.sql,
 * applied automatically on server boot. This file only inserts rows.
 *
 * Every seed function checks COUNT before inserting, so re-running is safe.
 *
 *   npm run db:seed
 */

import pg from "pg";
import { readFileSync } from "node:fs";
import { scryptSync, randomBytes } from "node:crypto";

/**
 * Thin adapter so every existing `db.execute(...)` call site below keeps its
 * current call shape (a string, or `{ sql, args }`) against a `pg.Pool`
 * instead of a libsql `Client`. Only each SQL string's placeholder syntax,
 * `RETURNING id` clauses, and `ON CONFLICT` clauses change (see steps below) —
 * the JS call sites themselves do not.
 */
function makeDb(pool) {
  return {
    async execute(query) {
      const { sql, args } =
        typeof query === "string" ? { sql: query, args: [] } : query;
      return pool.query(sql, args);
    },
  };
}

/* ─────────────────────────────────────────────
   PASSWORD HASHING (Node.js built-in crypto)
───────────────────────────────────────────── */

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const buf = scryptSync(password, salt, 64);
  return `${buf.toString("hex")}.${salt}`;
}

/* ─────────────────────────────────────────────
   SEED DATA
───────────────────────────────────────────── */

export async function seedIfEmpty(db) {
  const count = (await db.execute("SELECT COUNT(*) as c FROM users")).rows[0];
  if (count.c > 0) return;

  // ── Users ──
  const adminResult = await db.execute({
    sql: `INSERT INTO users (first_name, last_name, email, password, role, department) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    args: ["Admin", "User", "admin@edstellar.com", hashPassword("Admin@123"), "admin", null],
  });
  const adminId = adminResult.rows[0].id;

  // ── Course 1 ──
  const c1Result = await db.execute({
    sql: `INSERT INTO courses (name, description) VALUES ($1, $2) RETURNING id`,
    args: [
      "Project Management Fundamentals",
      "Master the core concepts of project management including planning, execution, and control. Perfect for aspiring project managers and team leads.",
    ],
  });
  const c1 = c1Result.rows[0].id;

  const c1m1Result = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c1, "Introduction to Project Management", "Foundations of PM concepts and lifecycle", 1],
  });
  const c1m1 = c1m1Result.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m1, "What is Project Management?", "An overview of project management and why it matters.", "video", "https://www.youtube.com/embed/GC7xs-tjNW4", 12, 1],
  });
  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m1, "Key PM Concepts & Terminology", "Essential terms every project manager must know.", "video", "https://www.youtube.com/embed/DdvSCPCGpoU", 15, 2],
  });

  const c1m2Result = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c1, "Planning & Scheduling", "How to plan and schedule projects effectively", 2],
  });
  const c1m2 = c1m2Result.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m2, "Work Breakdown Structure (WBS)", "Breaking down project scope into manageable work packages.", "video", "https://www.youtube.com/embed/J8p7H7ipToE", 18, 1],
  });
  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m2, "Creating a Project Schedule", "Gantt charts, dependencies, and milestone planning.", "video", "https://www.youtube.com/embed/SCtThLSX28g", 20, 2],
  });

  const c1m3Result = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c1, "Risk & Quality Management", "Identifying risks and maintaining quality standards", 3],
  });
  const c1m3 = c1m3Result.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m3, "Risk Identification & Assessment", "How to identify, analyze, and respond to project risks.", "video", "https://www.youtube.com/embed/OU2zexbOEVs", 16, 1],
  });
  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c1m3, "Quality Management Basics", "Quality planning, assurance, and control in projects.", "video", "https://www.youtube.com/embed/D_XiGF4uSNs", 14, 2],
  });

  // Assessment for Course 1
  const a1Result = await db.execute({
    sql: "INSERT INTO assessments (course_id, title, description, passing_score) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c1, "PM Fundamentals Quiz", "Test your knowledge of project management fundamentals.", 60],
  });
  const a1 = a1Result.rows[0].id;

  const q1Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a1, "What is the primary purpose of a Work Breakdown Structure (WBS)?", 1, 1],
  });
  const q1 = q1Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q1, "To break down the project scope into manageable sections", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q1, "To estimate project costs", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q1, "To identify project risks", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q1, "To assign team members to tasks", 0] });

  const q2Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a1, "Which is NOT a phase of the Project Management lifecycle?", 1, 2],
  });
  const q2 = q2Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q2, "Initiating", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q2, "Planning", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q2, "Designing", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q2, "Closing", 0] });

  const q3Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a1, "What does the acronym SMART stand for in goal setting?", 1, 3],
  });
  const q3 = q3Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q3, "Systematic, Measurable, Accurate, Realistic, Time-bound", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q3, "Specific, Measurable, Achievable, Relevant, Time-bound", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q3, "Simple, Manageable, Achievable, Realistic, Trackable", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q3, "Specific, Monitored, Accurate, Resourced, Timed", 0] });

  const q4Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a1, "A Gantt chart is primarily used to:", 1, 4],
  });
  const q4 = q4Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q4, "Identify project stakeholders", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q4, "Visualize project schedule and timeline", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q4, "Track project budget", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q4, "Manage team communications", 0] });

  const q5Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a1, "Which document formally authorizes a project?", 1, 5],
  });
  const q5 = q5Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q5, "Project Plan", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q5, "Statement of Work", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q5, "Project Charter", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q5, "Risk Register", 0] });

  // ── Course 2 ──
  const c2Result = await db.execute({
    sql: `INSERT INTO courses (name, description) VALUES ($1, $2) RETURNING id`,
    args: [
      "Agile & Scrum Essentials",
      "Learn the Agile methodology and Scrum framework from scratch. Build a strong foundation for agile project delivery and iterative development.",
    ],
  });
  const c2 = c2Result.rows[0].id;

  const c2m1Result = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c2, "Agile Foundations", "The Agile manifesto, values, and principles", 1],
  });
  const c2m1 = c2m1Result.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c2m1, "Agile Manifesto & Principles", "Understanding the 4 values and 12 principles of the Agile Manifesto.", "video", "https://www.youtube.com/embed/Z9QbYZh1YXY", 10, 1],
  });
  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c2m1, "Agile vs Traditional Methods", "Comparing Agile and Waterfall approaches to project delivery.", "video", "https://www.youtube.com/embed/WjwEh15M5Rw", 12, 2],
  });

  const c2m2Result = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c2, "Scrum Framework", "Roles, events, and artifacts of Scrum", 2],
  });
  const c2m2 = c2m2Result.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c2m2, "Scrum Roles & Responsibilities", "Product Owner, Scrum Master, and Development Team explained.", "video", "https://www.youtube.com/embed/m5u0P1WPfvs", 14, 1],
  });
  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [c2m2, "Scrum Events & Ceremonies", "Sprint Planning, Daily Scrum, Sprint Review, and Retrospective.", "video", "https://www.youtube.com/embed/evOhJeOF9mk", 16, 2],
  });

  // Assessment for Course 2
  const a2Result = await db.execute({
    sql: "INSERT INTO assessments (course_id, title, description, passing_score) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [c2, "Agile & Scrum Quiz", "Validate your understanding of Agile and Scrum concepts.", 60],
  });
  const a2 = a2Result.rows[0].id;

  const q6Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a2, "The Agile Manifesto values 'Working software over' what?", 1, 1],
  });
  const q6 = q6Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q6, "Customer collaboration", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q6, "Responding to change", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q6, "Comprehensive documentation", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q6, "Individuals and interactions", 0] });

  const q7Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a2, "In Scrum, who is responsible for maximizing the value of the product?", 1, 2],
  });
  const q7 = q7Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q7, "Scrum Master", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q7, "Development Team", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q7, "Product Owner", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q7, "Stakeholders", 0] });

  const q8Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a2, "What is the typical duration of a Sprint?", 1, 3],
  });
  const q8 = q8Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q8, "1 day", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q8, "1 to 4 weeks", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q8, "3 months", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q8, "6 months", 0] });

  const q9Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a2, "Which Scrum event is used to inspect and adapt the process?", 1, 4],
  });
  const q9 = q9Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q9, "Sprint Planning", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q9, "Daily Scrum", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q9, "Sprint Review", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q9, "Sprint Retrospective", 1] });

  const q10Result = await db.execute({
    sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [a2, "What artifact represents the work to be done in a Sprint?", 1, 5],
  });
  const q10 = q10Result.rows[0].id;
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q10, "Product Backlog", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q10, "Sprint Backlog", 1] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q10, "Increment", 0] });
  await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [q10, "Sprint Goal", 0] });
}

/* ─────────────────────────────────────────────
   ENSURE AI BANKING COURSE
   Runs on every startup — idempotent (checks before inserting)
───────────────────────────────────────────── */

export async function seedBankingCourse(db) {
  // Migrate old name if present
  const oldExists = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["AI Banking Course"] })).rows[0];
  if (oldExists) {
    await db.execute({ sql: "UPDATE courses SET name = $1 WHERE name = $2", args: ["AI for Banking", "AI Banking Course"] });
    return;
  }

  const exists = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["AI for Banking"] })).rows[0];
  if (exists) return;

  const courseResult = await db.execute({
    sql: `INSERT INTO courses (name, description) VALUES ($1, $2) RETURNING id`,
    args: [
      "AI for Banking",
      "Understand how Artificial Intelligence is transforming modern banking — from legacy pipeline failures to AI-driven fraud detection, credit decisions, and personalised customer engagement.",
    ],
  });
  const courseId = courseResult.rows[0].id;

  const moduleResult = await db.execute({
    sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [
      courseId,
      "AI in Modern Banking Operations",
      "How AI addresses legacy pipeline failures, parallel processing, fraud detection, and personalised engagement.",
      1,
    ],
  });
  const moduleId = moduleResult.rows[0].id;

  await db.execute({
    sql: "INSERT INTO lessons (module_id, title, description, content_type, content_url, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    args: [
      moduleId,
      "Introduction to AI in Banking",
      "An overview of how AI is replacing legacy fragmented pipelines in modern financial institutions.",
      "video",
      "https://youtu.be/EAe48VzZ7Fc?si=JuKyzNtuTdEZqyDB",
      5,
      1,
    ],
  });

  const assessmentResult = await db.execute({
    sql: "INSERT INTO assessments (course_id, title, description, passing_score) VALUES ($1,$2,$3,$4) RETURNING id",
    args: [
      courseId,
      "AI in Modern Banking Operations — Quiz",
      "Test your understanding of how AI addresses legacy pipeline failures, fraud detection, credit decisioning, and customer engagement in modern banking.",
      60,
    ],
  });
  const assessmentId = assessmentResult.rows[0].id;

  const qs = [
    { q: "What operational paradox do financial institutions face in modern banking?", opts: [["Customer expectations are declining while data volumes shrink", 0], ["Data volume is expanding exponentially while required response time is shrinking to zero", 1], ["Digital infrastructure is improving but customer trust is declining", 0], ["Manual processing is faster than digital systems", 0]] },
    { q: "What is the primary structural problem identified in legacy banking pipelines?", opts: [["Lack of customer-facing mobile applications", 0], ["Over-reliance on cloud computing systems", 0], ["Rigid single-file sequences built around fragmented systems and manual checks", 1], ["Too many parallel processing streams running simultaneously", 0]] },
    { q: "What happens when human teams step in to review documents in a legacy pipeline?", opts: [["Processing speed doubles due to human accuracy", 0], ["The single-file sequence breaks down, creating immediate systemic friction", 1], ["Customer satisfaction improves due to personal attention", 0], ["Fraud detection rates increase significantly", 0]] },
    { q: "What is the internal consequence of manual processing in legacy banking systems?", opts: [["Increased regulatory compliance and audit trails", 0], ["Higher customer retention and satisfaction scores", 0], ["Manual fatigue and fragmented views of customer data leading to inconsistent decision-making", 1], ["Reduced operational costs across all departments", 0]] },
    { q: "What does the transcript state about implementing Artificial Intelligence in banking?", opts: [["It is an optional upgrade for large institutions only", 0], ["It is a future concept still being tested in pilot programs", 0], ["It is a strict operational necessity", 1], ["It is primarily useful for marketing and customer acquisition", 0]] },
    { q: "What is the primary function of the central AI decision engine described in the transcript?", opts: [["To replace human relationship managers in branch banking", 0], ["To ingest continuous, massive volumes of both structured and unstructured data", 1], ["To manage regulatory filings and compliance documentation", 0], ["To automate employee payroll and internal HR functions", 0]] },
    { q: "How does parallel processing in AI architecture improve banking operations?", opts: [["It reduces the number of servers required to run banking systems", 0], ["It increases the number of human reviewers needed per transaction", 0], ["It completely bypasses the sequential delays that choked the legacy pipeline", 1], ["It simplifies the user interface for mobile banking customers", 0]] },
    { q: "What is a key advantage of algorithmic processing over human operators in document review?", opts: [["Algorithms can only process structured data, making them more accurate", 0], ["A human operator processes documents faster when supported by AI tools", 0], ["An algorithm cross-references thousands of inputs simultaneously, identifying complex patterns invisible to the human eye", 1], ["Algorithms reduce data storage costs by compressing transaction records", 0]] },
    { q: "How does the legacy fraud detection system operate, according to the transcript?", opts: [["It uses real-time AI monitoring to flag transactions before completion", 0], ["It relies on retroactive human analysis reviewing transactions after they happen", 1], ["It uses behavioral baselines to predict fraudulent accounts in advance", 0], ["It blocks all international transactions by default for security", 0]] },
    { q: "At what point does the AI fraud detection system trigger an alert?", opts: [["After the transaction has been completed and reported by the customer", 0], ["During the monthly account reconciliation process", 0], ["When a transaction stream deviates from established behavioral baselines, in milliseconds", 1], ["When the customer manually flags a suspicious charge in the app", 0]] },
    { q: "What is the deeper value of AI-powered virtual assistants beyond 24/7 availability?", opts: [["They reduce the need for mobile banking applications", 0], ["They generate behavioral personalization by pulling discrete historical data points to create relevant recommendations", 1], ["They replace relationship managers for high-net-worth customers", 0], ["They provide multilingual support across all global markets", 0]] },
    { q: "How does AI transform the customer service function in banking?", opts: [["From a digital-first model to a branch-based experience", 0], ["From proactive engagement to reactive cost management", 0], ["From a reactive high-friction cost center to a proactive tool for personalized engagement", 1], ["From automated processing to fully manual high-touch service", 0]] },
    { q: "What is the core advantage of AI in credit and loan application processing?", opts: [["It slows down application processing to ensure greater accuracy", 0], ["It evaluates a significantly wider set of variables simultaneously than any human underwriter could process", 1], ["It reduces the number of loan products available to consumers", 0], ["It increases paperwork requirements to reduce default risk", 0]] },
    { q: "What operational balance does algorithmic lending achieve?", opts: [["It prioritises institutional profit over customer access to capital", 0], ["It eliminates risk entirely from the lending portfolio", 0], ["It expands customer access to capital while maintaining strict, calculated risk management", 1], ["It reduces loan approval rates to minimise institutional exposure", 0]] },
    { q: "What does the transcript identify as the only mathematical way for a bank to remain secure, efficient, and future-ready?", opts: [["Hiring more skilled analysts and expanding human review teams", 0], ["Investing in branch infrastructure and physical security systems", 0], ["Abandoning manual fragmentation for an integrated algorithmic architecture", 1], ["Partnering with fintech startups to outsource core processing functions", 0]] },
  ];

  for (let idx = 0; idx < qs.length; idx++) {
    const item = qs[idx];
    const qResult = await db.execute({
      sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
      args: [assessmentId, item.q, 1, idx + 1],
    });
    const qId = qResult.rows[0].id;
    for (const [text, correct] of item.opts) {
      await db.execute({
        sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)",
        args: [qId, text, correct],
      });
    }
  }
}

/* ─────────────────────────────────────────────
   SEED EXTRA LESSONS + COURSE 4
   Idempotent — checks by course name / lesson count
───────────────────────────────────────────── */

export async function seedExtraContent(db) {
  // Only run if Course 4 doesn't exist yet
  const c4Exists = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Leadership & Communication"] })).rows[0];
  if (c4Exists) return;

  // ── Add modules/lessons to Course 1 ──
  const c1 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Project Management Fundamentals"] })).rows[0]?.id;
  if (c1) {
    const m4 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c1, "Stakeholder Management", "Identifying and managing project stakeholders", 4] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Identifying Project Stakeholders", "Tools to find and analyse everyone with a stake in your project.", 18, 1],
      ["Stakeholder Communication Planning", "How to plan what, when and how to communicate.", 20, 2],
      ["Managing Stakeholder Expectations", "Techniques to align expectations and resolve conflicts.", 17, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m4, t, d, "video", min, ord] });

    const m5 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c1, "Budget & Resource Management", "Estimating costs and managing project resources", 5] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Project Cost Estimation Techniques", "Analogous, parametric and bottom-up estimating methods.", 22, 1],
      ["Resource Planning & Allocation", "Matching people and materials to project tasks.", 20, 2],
      ["Earned Value Management (EVM)", "Track cost and schedule performance with EVM metrics.", 18, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m5, t, d, "video", min, ord] });

    const m6 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c1, "Monitoring, Change & Closure", "Keeping projects on track and closing them properly", 6] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Project Performance Metrics & KPIs", "Key indicators to monitor project health.", 16, 1],
      ["Change Management in Projects", "How to handle scope changes without derailing delivery.", 18, 2],
      ["Project Closure & Lessons Learned", "Formal closure steps and capturing what worked.", 15, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m6, t, d, "video", min, ord] });
  }

  // ── Add modules/lessons to Course 2 ──
  const c2 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Agile & Scrum Essentials"] })).rows[0]?.id;
  if (c2) {
    const m3 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c2, "Kanban & Lean", "Visualising flow and eliminating waste", 3] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Kanban Principles & Visualisation", "WIP limits, pull systems and flow metrics.", 16, 1],
      ["Lean Methodology Basics", "Value stream mapping and the seven types of waste.", 18, 2],
      ["Building & Running a Kanban Board", "Practical walkthrough of setting up and using Kanban.", 15, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m3, t, d, "video", min, ord] });

    const m4 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c2, "Scaling Agile", "Frameworks for scaling Agile across large organisations", 4] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["SAFe Framework Introduction", "Scaled Agile Framework: trains, PI planning and ARTs.", 20, 1],
      ["Large-Scale Scrum (LeSS) Basics", "Applying Scrum principles to multi-team programmes.", 18, 2],
      ["Agile Release Trains & PI Planning", "Synchronising multiple teams around a shared programme increment.", 16, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m4, t, d, "video", min, ord] });
  }

  // ── Add modules/lessons to Course 3 ──
  const c3 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["AI for Banking"] })).rows[0]?.id;
  if (c3) {
    const m2 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c3, "AI in Risk & Compliance", "Using AI for risk modelling, fraud detection and compliance", 2] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Credit Risk Modelling with AI", "How machine learning improves credit-scoring accuracy.", 18, 1],
      ["AI-Powered Fraud Detection", "Real-time anomaly detection and adaptive fraud prevention.", 20, 2],
      ["Regulatory Compliance & Explainable AI", "Meeting GDPR, Basel III and explainability requirements.", 15, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m2, t, d, "video", min, ord] });

    const m3 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c3, "Future of AI in Finance", "Emerging AI use-cases transforming financial services", 3] })).rows[0].id;
    for (const [t, d, min, ord] of [
      ["Conversational AI & Banking Chatbots", "Virtual assistants, NLP and omnichannel service delivery.", 16, 1],
      ["Robo-Advisory & Wealth Management AI", "Algorithm-driven portfolio management and client onboarding.", 17, 2],
      ["AI Ethics & Responsible Innovation in Finance", "Bias, fairness, accountability and governance in financial AI.", 14, 3],
    ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m3, t, d, "video", min, ord] });
  }

  // ── Course 4: Leadership & Communication ──
  const c4Res = await db.execute({ sql: "INSERT INTO courses (name, description) VALUES ($1,$2) RETURNING id", args: ["Leadership & Communication", "Develop the leadership mindset and communication skills needed to inspire teams, manage conflict, and drive organisational performance."] });
  const c4 = c4Res.rows[0].id;

  const lc1 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c4, "Foundations of Leadership", "Core leadership principles and styles", 1] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["What Makes a Great Leader?", "Traits, mindsets and behaviours that define effective leaders.", 20, 1],
    ["Leadership Styles & When to Use Them", "Situational, transformational and servant leadership models.", 18, 2],
    ["Building Trust & Credibility", "How leaders build psychological safety and long-term trust.", 17, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [lc1, t, d, "video", min, ord] });

  const lc2 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c4, "Effective Communication", "Communication frameworks for leaders", 2] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["Communication Models & Frameworks", "Shannon-Weaver, assertive vs passive vs aggressive styles.", 16, 1],
    ["Active Listening Skills", "Techniques to listen with intent and demonstrate understanding.", 18, 2],
    ["Giving & Receiving Feedback", "SBI model, radical candour and growth-focused feedback cultures.", 20, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [lc2, t, d, "video", min, ord] });

  const lc3 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c4, "Team Dynamics & Conflict", "Building high-performing teams and navigating conflict", 3] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["High-Performance Teams", "Tuckman's stages, team charters and psychological safety.", 17, 1],
    ["Managing Conflict at Work", "Thomas-Kilmann model and mediation techniques.", 19, 2],
    ["Motivation & Employee Engagement", "Maslow, Herzberg and intrinsic motivation in the workplace.", 18, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [lc3, t, d, "video", min, ord] });

  const lc4 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [c4, "Emotional Intelligence", "Self-awareness, empathy and resilience for leaders", 4] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["Understanding Emotional Intelligence (EQ)", "Goleman's five dimensions of EQ and why they matter for leaders.", 16, 1],
    ["Self-Awareness & Self-Regulation", "Identifying triggers, managing reactions and staying composed.", 18, 2],
    ["Empathy & Social Awareness at Work", "Reading the room, perspective-taking and inclusive leadership.", 15, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [lc4, t, d, "video", min, ord] });

  // Assessment for Course 4
  const a4Res = await db.execute({ sql: "INSERT INTO assessments (course_id, title, description, passing_score) VALUES ($1,$2,$3,$4) RETURNING id", args: [c4, "Leadership & Communication Quiz", "Test your understanding of leadership styles, communication frameworks and team dynamics.", 60] });
  const a4 = a4Res.rows[0].id;

  for (const [idx, q, opts] of [
    [1, "Which leadership style adjusts approach based on the follower's readiness?", [["Transformational", 0], ["Situational Leadership", 1], ["Autocratic", 0], ["Laissez-faire", 0]]],
    [2, "The SBI feedback model stands for:", [["Subject, Behaviour, Impact", 0], ["Situation, Behaviour, Impact", 1], ["Situation, Background, Insight", 0], ["Subject, Background, Intent", 0]]],
    [3, "In Tuckman's model, which stage involves high conflict as roles are established?", [["Forming", 0], ["Storming", 1], ["Norming", 0], ["Performing", 0]]],
    [4, "Which of Goleman's EQ dimensions involves recognising emotions in others?", [["Self-awareness", 0], ["Self-regulation", 0], ["Empathy", 1], ["Motivation", 0]]],
    [5, "Herzberg's two-factor theory distinguishes between:", [["Leadership styles and follower maturity", 0], ["Hygiene factors and motivators", 1], ["Intrinsic and extrinsic goals", 0], ["Formal and informal communication channels", 0]]],
  ]) {
    const qRes = await db.execute({ sql: "INSERT INTO assessment_questions (assessment_id, question_text, marks, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [a4, q, 1, idx] });
    for (const [text, correct] of opts)
      await db.execute({ sql: "INSERT INTO assessment_options (question_id, option_text, is_correct) VALUES ($1,$2,$3)", args: [qRes.rows[0].id, text, correct] });
  }
}

/* ─────────────────────────────────────────────
   SEED 15 LEARNERS WITH COMPLETIONS
   Idempotent — skips if >= 15 learner users exist
───────────────────────────────────────────── */

export async function seedLearners(db) {
  const cnt = (await db.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'learner'")).rows[0].c;
  if (cnt >= 15) return;

  const admin = (await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1")).rows[0];
  const adminId = admin?.id ?? 1;

  // All lesson IDs ordered by id (insertion order = course order)
  const allLessons = (await db.execute("SELECT id, duration_minutes FROM lessons ORDER BY id")).rows;
  const allCourseIds = (await db.execute("SELECT id FROM courses ORDER BY id")).rows.map((r) => r.id);

  // Assessments with their question counts
  const assessments = (await db.execute(`
    SELECT a.id, a.passing_score, COUNT(aq.id) AS total_q
    FROM assessments a
    JOIN assessment_questions aq ON aq.assessment_id = a.id
    GROUP BY a.id
    ORDER BY a.id
  `)).rows;

  // [first, last, email, dept, location, job_role, juneCount, mayCount, score, attempt: 1=passed 2=failed 0=none]
  const LEARNERS = [
    { first:"Sneha",   last:"Kulkarni", email:"sneha.k@edstellar.com",   dept:"Engineering", location:"Bangalore",  job_role:"Software Engineer",        june:38, may:5,  score:93, attempt:1 },
    { first:"Kartik",  last:"Reddy",    email:"kartik.r@edstellar.com",   dept:"Sales",       location:"Mumbai",     job_role:"Sales Manager",            june:36, may:5,  score:88, attempt:1 },
    { first:"Rahul",   last:"Verma",    email:"rahul.v@edstellar.com",    dept:"Engineering", location:"Hyderabad",  job_role:"Backend Developer",        june:32, may:6,  score:82, attempt:1 },
    { first:"Manish",  last:"Gupta",    email:"manish.g@edstellar.com",   dept:"HR",          location:"Delhi",      job_role:"HR Manager",               june:30, may:5,  score:78, attempt:1 },
    { first:"Arun",    last:"Kumar",    email:"arun.k@edstellar.com",     dept:"Sales",       location:"Chennai",    job_role:"Sales Executive",          june:28, may:5,  score:75, attempt:1 },
    { first:"Priya",   last:"Sharma",   email:"priya.s@edstellar.com",    dept:"Sales",       location:"Mumbai",     job_role:"Senior Sales Executive",   june:26, may:5,  score:71, attempt:1 },
    { first:"Rohan",   last:"Desai",    email:"rohan.d@edstellar.com",    dept:"Operations",  location:"Pune",       job_role:"Operations Analyst",       june:24, may:4,  score:68, attempt:1 },
    { first:"Ananya",  last:"Singh",    email:"ananya.s@edstellar.com",   dept:"Operations",  location:"Delhi",      job_role:"Operations Coordinator",   june:22, may:4,  score:63, attempt:1 },
    { first:"Pooja",   last:"Bhatt",    email:"pooja.b@edstellar.com",    dept:"Engineering", location:"Bangalore",  job_role:"Frontend Developer",       june:20, may:4,  score:60, attempt:1 },
    { first:"Vikram",  last:"Iyer",     email:"vikram.i@edstellar.com",   dept:"Engineering", location:"Hyderabad",  job_role:"DevOps Engineer",          june:16, may:3,  score:52, attempt:2 },
    { first:"Nisha",   last:"Menon",    email:"nisha.m@edstellar.com",    dept:"HR",          location:"Kochi",      job_role:"HR Coordinator",           june:14, may:3,  score:48, attempt:2 },
    { first:"Deepak",  last:"Nair",     email:"deepak.n@edstellar.com",   dept:"Operations",  location:"Chennai",    job_role:"Operations Manager",       june:12, may:2,  score:44, attempt:2 },
    { first:"Kavita",  last:"Joshi",    email:"kavita.j@edstellar.com",   dept:"Sales",       location:"Pune",       job_role:"Sales Associate",          june:10, may:2,  score:0,  attempt:0 },
    { first:"Suresh",  last:"Patel",    email:"suresh.p@edstellar.com",   dept:"Operations",  location:"Ahmedabad",  job_role:"Operations Analyst",       june:8,  may:2,  score:0,  attempt:0 },
    { first:"Meena",   last:"Iyer",     email:"meena.i@edstellar.com",    dept:"HR",          location:"Bangalore",  job_role:"HR Specialist",            june:6,  may:1,  score:0,  attempt:0 },
  ];

  const total = allLessons.length;

  for (let li = 0; li < LEARNERS.length; li++) {
    const l = LEARNERS[li];

    // Insert user
    const uRes = await db.execute({
      sql: "INSERT INTO users (first_name, last_name, email, password, role, department, location, job_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (email) DO NOTHING RETURNING id",
      args: [l.first, l.last, l.email, hashPassword("Learner@123"), "learner", l.dept, l.location, l.job_role],
    });
    const userId = uRes.rows[0]?.id;
    if (!userId) continue; // already exists (IGNORE)

    // Assign to all courses
    for (const courseId of allCourseIds) {
      await db.execute({
        sql: "INSERT INTO user_course_assignments (user_id, course_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT (user_id, course_id) DO NOTHING",
        args: [userId, courseId, adminId],
      });
    }

    // June completions — spread across June 1–28
    const juneCount = Math.min(l.june, total);
    for (let i = 0; i < juneCount; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      await db.execute({
        sql: "INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, lesson_id) DO NOTHING",
        args: [userId, allLessons[i].id, `2026-06-${day} 09:00:00`],
      });
    }

    // May completions — next slice of lessons
    const mayStart = juneCount;
    const mayCount = Math.min(l.may, total - mayStart);
    for (let i = 0; i < mayCount; i++) {
      const day = String((i % 20) + 8).padStart(2, "0");
      await db.execute({
        sql: "INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, lesson_id) DO NOTHING",
        args: [userId, allLessons[mayStart + i].id, `2026-05-${day} 09:00:00`],
      });
    }

    // Assessment attempts
    if (l.attempt > 0) {
      const submittedDay = String(10 + li).padStart(2, "0");
      for (const asmt of assessments) {
        const totalQ = Number(asmt.total_q);
        const pct = l.attempt === 1 ? l.score : l.score;
        const numCorrect = Math.round(pct * totalQ / 100);
        const isPassed = pct >= Number(asmt.passing_score) ? 1 : 0;
        await db.execute({
          sql: "INSERT INTO user_assessment_attempts (user_id, assessment_id, score, total_questions, percentage, is_passed, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          args: [userId, asmt.id, numCorrect, totalQ, pct, isPassed, `2026-06-${submittedDay} 14:00:00`],
        });
      }
    }
  }
}

/* ─────────────────────────────────────────────
   SEED DEMO LEARNER (demolearner@gmail.com)
   Idempotent — checks by email then by completion count
───────────────────────────────────────────── */

export async function seedDemoLearner(db) {
  // 1. Get or create the demo user
  let demoUser = (await db.execute({ sql: "SELECT id FROM users WHERE email = $1", args: ["demolearner@gmail.com"] })).rows[0];

  if (!demoUser) {
    const res = await db.execute({
      sql: "INSERT INTO users (first_name, last_name, email, password, role, department, location, job_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      args: ["Priya", "Sharma", "demolearner@gmail.com", hashPassword("Demo@123"), "learner", "Sales", "Mumbai", "Senior Sales Executive"],
    });
    demoUser = { id: res.rows[0].id };
  }

  const userId = demoUser.id;

  // 2. Assign to all courses
  const courses = (await db.execute("SELECT id FROM courses ORDER BY id")).rows;
  const admin = (await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1")).rows[0];

  for (const course of courses) {
    await db.execute({
      sql: "INSERT INTO user_course_assignments (user_id, course_id, assigned_by, assigned_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, course_id) DO NOTHING",
      args: [userId, course.id, admin?.id ?? 1, "2026-06-01 08:00:00"],
    });
  }

  // 3. Skip if completions already seeded
  const existingCnt = (await db.execute({ sql: "SELECT COUNT(*) AS c FROM user_lesson_completions WHERE user_id = $1", args: [userId] })).rows[0].c;
  if (existingCnt >= 15) return;

  // 4. Seed partial lesson completions per course
  const allLessons = (await db.execute(`
    SELECT l.id, l.duration_minutes, cm.course_id
    FROM lessons l
    JOIN course_modules cm ON cm.id = l.module_id
    ORDER BY cm.course_id, cm.sort_order, l.sort_order
  `)).rows;

  const lessonsByCourse = {};
  for (const l of allLessons) {
    if (!lessonsByCourse[l.course_id]) lessonsByCourse[l.course_id] = [];
    lessonsByCourse[l.course_id].push(l);
  }

  // completion ratios: C1 80%, C2 60%, C3 43%, C4 17%
  const courseIds = courses.map((c) => c.id);
  const ratios = [0.80, 0.60, 0.43, 0.17];
  let dayIdx = 0;

  for (let ci = 0; ci < courseIds.length; ci++) {
    const lessons = lessonsByCourse[courseIds[ci]] || [];
    const count = Math.min(Math.floor(lessons.length * (ratios[ci] ?? 0.3)), lessons.length);
    for (let i = 0; i < count; i++) {
      const day = String((dayIdx % 13) + 1).padStart(2, "0");
      dayIdx++;
      await db.execute({
        sql: "INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, lesson_id) DO NOTHING",
        args: [userId, lessons[i].id, `2026-06-${day} 10:${String((i * 7) % 60).padStart(2, "0")}:00`],
      });
    }
  }

  // Update location/job_role for demolearner if missing (idempotent)
  await db.execute({
    sql: "UPDATE users SET location = $1, job_role = $2 WHERE email = $3 AND (location IS NULL OR location = '')",
    args: ["Mumbai", "Senior Sales Executive", "demolearner@gmail.com"],
  });

  // 5. Seed assessment attempt for course 1 (passed, 78%)
  const existingAttempts = (await db.execute({ sql: "SELECT COUNT(*) AS c FROM user_assessment_attempts WHERE user_id = $1", args: [userId] })).rows[0].c;
  if (Number(existingAttempts) === 0) {
    const a1 = (await db.execute({
      sql: `SELECT a.id, a.passing_score, COUNT(aq.id) AS total_q
            FROM assessments a
            JOIN assessment_questions aq ON aq.assessment_id = a.id
            WHERE a.course_id = $1 GROUP BY a.id LIMIT 1`,
      args: [courseIds[0]],
    })).rows[0];
    if (a1) {
      const pct = 78;
      await db.execute({
        sql: "INSERT INTO user_assessment_attempts (user_id, assessment_id, score, total_questions, percentage, is_passed, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        args: [userId, a1.id, Math.round(pct * Number(a1.total_q) / 100), Number(a1.total_q), pct, 1, "2026-06-10 14:00:00"],
      });
    }
  }
}

/* ─────────────────────────────────────────────
   SEED PROFILE MIGRATION
   Backfills location + job_role for already-seeded users
   Idempotent — only updates rows where location IS NULL
───────────────────────────────────────────── */

/* ─────────────────────────────────────────────
   SEED DRAFT COURSE — Data Analytics Fundamentals
   Idempotent — skips if course already exists
───────────────────────────────────────────── */

export async function seedDraftCourse(db) {
  const exists = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Data Analytics Fundamentals"] })).rows[0];
  if (exists) return;

  const cRes = await db.execute({
    sql: `INSERT INTO courses (name, description, is_active) VALUES ($1,$2,0) RETURNING id`,
    args: [
      "Data Analytics Fundamentals",
      "A comprehensive introduction to data analytics — from raw data collection and cleaning through to visualisation and storytelling. This course is currently in draft and not yet available to learners.",
    ],
  });
  const cId = cRes.rows[0].id;

  // ── Module 1: Data Collection & Cleaning ──
  const m1 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [cId, "Data Collection & Cleaning", "How to gather, assess and prepare data for analysis", 1] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["Introduction to Data Sources",           "Structured vs unstructured data, APIs, databases and flat files.",   15, 1],
    ["Data Cleaning Techniques",               "Handling missing values, outliers and duplicate records.",           18, 2],
    ["Data Transformation & Normalisation",    "Reshaping, encoding and scaling data for downstream analysis.",      16, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m1, t, d, "video", min, ord] });

  // ── Module 2: Exploratory Data Analysis ──
  const m2 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [cId, "Exploratory Data Analysis", "Statistical methods and visualisations to understand your data", 2] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["Descriptive Statistics",                 "Mean, median, variance, skewness and percentile analysis.",          17, 1],
    ["Correlation & Distribution Analysis",    "Scatter plots, histograms and identifying relationships in data.",   19, 2],
    ["Identifying Patterns & Anomalies",       "Trend detection, seasonality and spotting outliers at scale.",       16, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m2, t, d, "video", min, ord] });

  // ── Module 3: Data Visualisation & Storytelling ──
  const m3 = (await db.execute({ sql: "INSERT INTO course_modules (course_id, title, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id", args: [cId, "Data Visualisation & Storytelling", "Turning insights into compelling, audience-ready visuals", 3] })).rows[0].id;
  for (const [t, d, min, ord] of [
    ["Choosing the Right Chart Type",          "Bar, line, pie, heatmap — when to use which and why.",               14, 1],
    ["Dashboard Design Principles",            "Layout, hierarchy and clarity in data dashboards.",                   18, 2],
    ["Storytelling with Data",                 "Crafting a narrative around insights to drive decisions.",            20, 3],
  ]) await db.execute({ sql: "INSERT INTO lessons (module_id, title, description, content_type, duration_minutes, sort_order) VALUES ($1,$2,$3,$4,$5,$6)", args: [m3, t, d, "video", min, ord] });
}

export async function seedProfileMigration(db) {
  const updates = [
    { email: "sneha.k@edstellar.com",   location: "Bangalore",  job_role: "Software Engineer"        },
    { email: "kartik.r@edstellar.com",  location: "Mumbai",     job_role: "Sales Manager"            },
    { email: "rahul.v@edstellar.com",   location: "Hyderabad",  job_role: "Backend Developer"        },
    { email: "manish.g@edstellar.com",  location: "Delhi",      job_role: "HR Manager"               },
    { email: "arun.k@edstellar.com",    location: "Chennai",    job_role: "Sales Executive"          },
    { email: "priya.s@edstellar.com",   location: "Mumbai",     job_role: "Senior Sales Executive"   },
    { email: "rohan.d@edstellar.com",   location: "Pune",       job_role: "Operations Analyst"       },
    { email: "ananya.s@edstellar.com",  location: "Delhi",      job_role: "Operations Coordinator"   },
    { email: "pooja.b@edstellar.com",   location: "Bangalore",  job_role: "Frontend Developer"       },
    { email: "vikram.i@edstellar.com",  location: "Hyderabad",  job_role: "DevOps Engineer"          },
    { email: "nisha.m@edstellar.com",   location: "Kochi",      job_role: "HR Coordinator"           },
    { email: "deepak.n@edstellar.com",  location: "Chennai",    job_role: "Operations Manager"       },
    { email: "kavita.j@edstellar.com",  location: "Pune",       job_role: "Sales Associate"          },
    { email: "suresh.p@edstellar.com",  location: "Ahmedabad",  job_role: "Operations Analyst"       },
    { email: "meena.i@edstellar.com",   location: "Bangalore",  job_role: "HR Specialist"            },
    { email: "demolearner@gmail.com",   location: "Mumbai",     job_role: "Senior Sales Executive"   },
  ];

  for (const u of updates) {
    await db.execute({
      sql: "UPDATE users SET location = $1, job_role = $2 WHERE email = $3 AND (location IS NULL OR location = '')",
      args: [u.location, u.job_role, u.email],
    });
  }
}

/* ─────────────────────────────────────────────
   SEED SESSIONS
   Idempotent — skips if any sessions exist
───────────────────────────────────────────── */

export async function seedSessions(db) {
  const count = (await db.execute("SELECT COUNT(*) as c FROM sessions")).rows[0];
  if (Number(count.c) > 0) return;

  const c1 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Project Management Fundamentals"] })).rows[0]?.id ?? null;
  const c2 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Agile & Scrum Essentials"] })).rows[0]?.id ?? null;
  const c3 = (await db.execute({ sql: "SELECT id FROM courses WHERE name = $1", args: ["Leadership & Communication"] })).rows[0]?.id ?? null;

  const sessions = [
    {
      title: "Project Management Bootcamp — Batch 1",
      session_type: "ILT",
      department: "Engineering",
      course_id: c1,
      capacity: 25,
      trainer: "Priya Sharma",
      venue_url: "Training Room A, Bangalore HQ",
      date: "2026-07-10",
      start_time: "09:00",
      end_time: "17:00",
      description: "Full-day intensive workshop covering PM fundamentals, risk management and stakeholder communication.",
      status: "upcoming",
    },
    {
      title: "Agile & Scrum Deep Dive — Virtual",
      session_type: "Virtual",
      department: "Engineering",
      course_id: c2,
      capacity: 30,
      trainer: "Rahul Verma",
      venue_url: "https://meet.google.com/abc-defg-hij",
      date: "2026-07-15",
      start_time: "10:00",
      end_time: "13:00",
      description: "Half-day virtual session on Scrum ceremonies, sprint planning, and backlog refinement best practices.",
      status: "upcoming",
    },
    {
      title: "Sales Leadership Masterclass",
      session_type: "ILT",
      department: "Sales",
      course_id: c3,
      capacity: 20,
      trainer: "Kartik Rao",
      venue_url: "Conference Room 3, Mumbai Office",
      date: "2026-06-05",
      start_time: "09:30",
      end_time: "16:30",
      description: "Interactive masterclass on leadership styles, motivating sales teams and driving revenue growth.",
      status: "completed",
    },
    {
      title: "HR Compliance & Policy Update",
      session_type: "Virtual",
      department: "HR",
      course_id: null,
      capacity: 50,
      trainer: "Manish Gupta",
      venue_url: "https://zoom.us/j/123456789",
      date: "2026-06-12",
      start_time: "11:00",
      end_time: "12:30",
      description: "Mandatory session covering 2026 policy updates, compliance requirements, and code of conduct refresher.",
      status: "completed",
    },
    {
      title: "Operations Excellence Workshop",
      session_type: "ILT",
      department: "Operations",
      course_id: null,
      capacity: 15,
      trainer: "Deepak Nair",
      venue_url: "Training Room B, Chennai Office",
      date: "2026-07-22",
      start_time: "09:00",
      end_time: "13:00",
      description: "Hands-on workshop focused on process optimisation, lean methodologies, and operational KPIs.",
      status: "upcoming",
    },
  ];

  for (const s of sessions) {
    await db.execute({
      sql: `INSERT INTO sessions (title, session_type, department, course_id, capacity, trainer, venue_url, date, start_time, end_time, description, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      args: [s.title, s.session_type, s.department, s.course_id, s.capacity, s.trainer, s.venue_url, s.date, s.start_time, s.end_time, s.description, s.status],
    });
  }

  // Seed roster + attendance — only if roster table is empty
  const rosterCount = (await db.execute("SELECT COUNT(*) as c FROM session_roster")).rows[0];
  if (Number(rosterCount.c) > 0) return;

  const completedSessions = (await db.execute("SELECT id FROM sessions WHERE status = 'completed'")).rows;
  const upcomingSessions  = (await db.execute("SELECT id FROM sessions WHERE status = 'upcoming' LIMIT 2")).rows;
  const allLearners       = (await db.execute("SELECT id FROM users WHERE role = 'learner' LIMIT 6")).rows;

  if (allLearners.length >= 4) {
    const statuses = ["present", "present", "present", "absent"];
    for (const sess of completedSessions) {
      for (let i = 0; i < 4; i++) {
        await db.execute({ sql: "INSERT INTO session_roster (session_id, user_id) VALUES ($1,$2) ON CONFLICT (session_id, user_id) DO NOTHING", args: [sess.id, allLearners[i].id] });
        await db.execute({ sql: "INSERT INTO session_attendance (session_id, user_id, status, is_locked) VALUES ($1,$2,$3,1) ON CONFLICT (session_id, user_id) DO NOTHING", args: [sess.id, allLearners[i].id, statuses[i]] });
      }
    }
  }

  const rosterLearners = allLearners.slice(0, 3);
  for (const sess of upcomingSessions) {
    for (const u of rosterLearners) {
      await db.execute({ sql: "INSERT INTO session_roster (session_id, user_id) VALUES ($1,$2) ON CONFLICT (session_id, user_id) DO NOTHING", args: [sess.id, u.id] });
    }
  }
}


/* ─────────────────────────────────────────────
   RUNNER — npm run db:seed
───────────────────────────────────────────── */

function loadEnv() {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || env.DATABASE_URL,
  ssl: (process.env.DATABASE_SSL || env.DATABASE_SSL) === "true"
    ? { rejectUnauthorized: false }
    : undefined,
});
const db = makeDb(pool);

/* Order matters: users and courses exist before anything references them. */
const steps = [
  ["core users + courses", seedIfEmpty],
  ["AI for Banking course", seedBankingCourse],
  ["extra course content", seedExtraContent],
  ["learner accounts", seedLearners],
  ["demo learner", seedDemoLearner],
  ["profile fields", seedProfileMigration],
  ["draft course", seedDraftCourse],
  ["training sessions", seedSessions],
];

for (const [label, fn] of steps) {
  await fn(db);
  console.log(`  seeded: ${label}`);
}

await pool.end();
console.log("Seeding complete.");
