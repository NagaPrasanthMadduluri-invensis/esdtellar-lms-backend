# Spec: Certificates

> First module for the agentic build. Chosen because it is self-contained (new tables, no
> cross-cutting auth changes), cleanly splits along the backend/frontend seam for parallel
> work, and exercises the certification/compliance + PII human checkpoints from the process.
> Replace or extend before building if you'd rather start elsewhere.

## 1. Goal
Issue a completion certificate to a learner when they finish a course (all lessons complete
AND, if the course has an assessment, a passing attempt exists). Admins manage/verify issued
certificates; learners view and download theirs. Fills the stubbed `/admin/certificates` and
`/certifications` pages (both currently "Coming Soon" placeholders with no API or tables).

## 2. Scope
**In scope:**
- A `certificates` table recording each issued certificate.
- Issuance logic: a course becomes "certifiable" for a learner when progress = 100% and any
  required assessment is passed. Issuance is idempotent (one certificate per user+course).
- Learner: list my certificates, view a single certificate detail, download (print-friendly HTML view is acceptable for v1).
- Admin: list all issued certificates (filter by learner/course), and revoke a certificate.
- A public-ish verification lookup by certificate code (`/api/certificates/verify/[code]`) returning only non-PII fields (course name, issue date, valid/revoked) — no learner email/employee_id.

**Out of scope (v1):**
- PDF binary generation / e-signing (print-to-PDF from the HTML view is enough for now).
- Certificate templates/branding editor.
- Expiry/renewal logic.
- Emailing certificates.

## 3. Data model
Add to `lib/db/schema.js` inside `createSchema()`:

```
CREATE TABLE IF NOT EXISTS certificates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  certificate_code TEXT UNIQUE NOT NULL,      -- e.g. EDS-<courseId>-<userId>-<shorthash>
  issued_at     TEXT NOT NULL,                -- ISO datetime
  final_score   INTEGER,                      -- best assessment % at issuance, or NULL if no assessment
  is_revoked    INTEGER NOT NULL DEFAULT 0,   -- 1 = revoked by admin
  revoked_at    TEXT,
  revoked_by    INTEGER REFERENCES users(id),
  UNIQUE(user_id, course_id)                  -- one certificate per learner per course
);
```
- Use the existing idempotent pattern; no seed data required (certificates are earned at runtime).
- `certificate_code` is generated server-side, never from client input.

> ⚠️ **Human checkpoint:** this schema/migration change and the issuance-eligibility logic
> (what counts as "course completed") are certification logic — a human reviews before merge.

## 4. API contract
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/learner/certificates` | learner | — | `{ certificates: [{ id, certificateCode, courseName, issuedAt, finalScore, isRevoked }] }` |
| _(issuance)_ | _auto at completion_ | — | — | Certificates are auto-issued by `autoIssueCertificate()` from the lesson-complete and assessment-attempt flows. There is **no learner issue endpoint** (removed as orphaned). |
| GET | `/api/learner/certificates/[id]` | learner (owner only) | — | `{ certificate: { ...detail incl. certificateCode, learnerName, courseName, issuedAt, finalScore } }` — 403 if not owner, 404 if missing |
| GET | `/api/admin/certificates` | admin | query: `?userId=&courseId=` | `{ certificates: [{ id, learnerName, courseName, certificateCode, issuedAt, finalScore, isRevoked }] }` |
| DELETE | `/api/admin/certificates/[id]` | admin | — | `{ ok: true }` — soft revoke: sets `is_revoked=1`, `revoked_at`, `revoked_by` (not row delete) |
| PATCH | `/api/admin/certificates/[id]` | admin | — | Re-issue/reinstate a revoked cert: `{ ok: true, certificate: { id, certificateCode, issuedAt, isRevoked:false } }`; 409 if not currently revoked; 404 if missing |
| GET | `/api/certificates/verify/[code]` | none | — | `{ valid: boolean, courseName, issuedAt, isRevoked }` — **no learner PII** |

- Eligibility check reuses the existing progress + best-assessment-score query pattern from
  `app/api/learner/courses/route.js` (progress % from `user_lesson_completions`; pass from
  `user_assessment_attempts.is_passed`). Learner id is `payload.userId`.

## 5. UI
**Learner — `/certifications`** (`app/(learner)/certifications/page.js`, already a Server shell
rendering `<CertificationsContent />`):
- Build `components/learner/certifications-content.jsx` (client): fetch `/api/learner/certificates`,
  show a grid of certificate cards (course name, issued date, score, verify code, Download button).
- Empty state: "No certificates yet — complete a course to earn one."
- Add a `loading.js` skeleton.
- Certificate detail / print view: a client component rendering a print-friendly certificate
  (learner name, course, date, code) with `window.print()` for download-as-PDF.

**Admin — `/admin/certificates`** (`app/(admin)/admin/certificates/page.js`, replace the
"Coming Soon" card):
- `components/admin/certificates-table.jsx` (client): fetch `/api/admin/certificates`, a shadcn
  `Table` with learner, course, code, issued date, score, status; filter by learner/course;
  Revoke action (with confirm dialog) → DELETE endpoint.
- Add a `loading.js` skeleton.

All UI per TASTE.md: `page.js` stays a Server Component; `<Text>`/`<Box>`; Tailwind only;
`components/ui/*` primitives; learner/admin components never cross-import.

## 6. Acceptance criteria (grading rubric)
1. `certificates` table created idempotently; server restarts don't error. **(security/correctness, high weight)**
2. Issuance endpoint issues ONLY when the course is 100% complete and any required assessment is passed; returns 422 with a clear message otherwise; 409 if already issued. **(certification logic, high weight)**
3. Issuance is idempotent — calling issue twice never creates a second row (enforced by `UNIQUE(user_id, course_id)`). 
4. `certificate_code` is unique, generated server-side, and never accepts a client-supplied code.
5. Every learner route uses `requireAuth` + rejects non-learners; the detail route returns 403 if the certificate isn't the caller's. Admin routes use `requireAdmin`. **(security, high weight)**
6. `/api/certificates/verify/[code]` returns NO learner PII (no email, employee_id, names) — only course name, issue date, validity. **(PII, high weight)**
7. All SQL parameterized; no secrets hardcoded. **(security, high weight)**
8. Revoke is a soft delete (`is_revoked=1`), not a row delete; verify + lists reflect revoked status.
9. Learner page shows populated / empty / loading / error states; `loading.js` present.
10. Admin page shows the table, filters work, revoke works with a confirm dialog; `loading.js` present.
11. TASTE.md conventions upheld (no `"use client"` on pages, `<Text>`/`<Box>`, no inline styles, no admin↔learner cross-imports) and new files match existing code patterns/idiom exactly. (No lint/tests — pattern conformance is checked by the reviewer + grader, not a linter.)

## 7. Human checkpoints (do NOT auto-merge)
- The `certificates` schema + migration.
- The issuance-eligibility ("course completed") logic — this is certification/compliance logic.
- The verify endpoint's field selection — must be re-checked by a human for PII leakage given the US/Europe/Singapore data-residency footprint.

## 7a. Decisions confirmed during build (human checkpoint sign-off)
- **Eligibility ignores retired assessments:** the eligibility query includes `AND a.is_active = 1`, so only currently-active assessments gate issuance (a deliberate divergence from `courses/route.js`, judged more correct). — *Confirmed.*
- **Revoke is reversible — ADMIN-only re-issue:** revoking a certificate does NOT permanently block it, but only an **admin** can reinstate it. `PATCH /api/admin/certificates/[id]` (wired to a "Re-issue" action shown on revoked rows in the admin table) re-stamps the row (`is_revoked→0`, new code + issued_at, clears `revoked_at`/`revoked_by`); it 409s if the certificate is not currently revoked. Learners have no self-service re-issue. — *Confirmed. The former learner `POST /api/learner/certificates/issue` route has been REMOVED as orphaned — initial issuance is auto-at-completion, re-issuance is admin-only.*
- **Auto-issue at completion:** certificates are issued automatically the moment a learner finishes a course — hooked into `POST /api/learner/lessons/[lessonId]/complete` and (on a passing attempt) `POST /api/learner/assessments/[assessmentId]/attempt` via `autoIssueCertificate()` in `lib/certificates.js`. It is best-effort (never breaks the completion flow) and **skips if any certificate row already exists — including a revoked one — so it never fights an admin revocation**. Eligibility logic is now a single shared function `evaluateCourseCompletion()` used by both the auto-issue path and the manual issue route. — *Confirmed; auto-issue at completion (not on-load reconcile).*
- **One-time backfill:** because auto-issue only fires on future completion events, a one-time backfill (`autoIssueCertificate` over all `user_course_assignments`) was run to issue certificates for learners who had already completed courses before this feature existed.

## 8. Non-goals / risks
- No PDF binary/e-sign in v1 (print view only). Revisit if formal certificates are required.
- Verify endpoint is unauthenticated by design — keep it strictly PII-free; consider rate-limiting later.
- Data residency: certificates contain learner PII at rest — note for the residency review, do not solve here.
