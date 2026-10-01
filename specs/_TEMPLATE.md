# Spec: <Module Name>

> Every module gets one of these BEFORE any agent writes code. The planner decomposes it;
> the build agents implement against it; the grader scores against the Acceptance Criteria.
> If a decision contradicts TASTE.md, update TASTE.md first — then this spec.

## 1. Goal
One paragraph: what this module does and who it's for (admin / learner / both).

## 2. Scope
**In scope:** bullet list of what this module includes.
**Out of scope:** what it explicitly does NOT include (prevents agents inventing scope).

## 3. Data model
New tables / columns (name, type, constraints). Note the migration approach
(`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` try/catch, per `lib/db/schema.js`).
Any seed data required, wired idempotently into `getDb()`.

> ⚠️ Any schema/migration change here is a **human checkpoint** — not auto-merged.

## 4. API contract
Each endpoint: method + path, auth requirement (learner/admin), request body shape,
response JSON shape, status codes. This is the interface between backend and frontend agents.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|

## 5. UI
Pages (route + Server-Component shell), client widgets (what they fetch), loading.js,
empty/error states. Which components are shared vs portal-specific.

## 6. Acceptance criteria (the grading rubric)
Numbered, testable, unambiguous. Each becomes a row in the grader's scorecard.
1. ...
2. ...

### 6a. End-to-end user journeys (MANDATORY — the "does it actually work?" criteria)
Write the COMPLETE path a real user takes, including how data first gets **created** — not just per-endpoint behavior. Every journey must be verifiable by driving the actual UI (not curl). This is where "the API is correct but the feature has no trigger" gets caught.
- **Journey (happy path):** As a <role>, I <do X in the UI> → I see <result>. e.g. "As a learner, I complete the last lesson of a course → a certificate appears on /certifications without any manual step."
- For each new API endpoint, name the **UI element or event that calls it**. An endpoint with no caller is a red flag — either add the trigger or cut the endpoint.
- Name the trigger for every piece of displayed data: what user action or system event creates it?

## 7. Human checkpoints
List anything in this module that a human MUST review before merge:
schema/migrations, certification/compliance logic, learner PII handling, data residency.

## 8. Non-goals / risks
Known edge cases, out-of-scope integrations, things to revisit later.
