# Spec: Transactional email, on a Postgres-backed outbox

> **Status: BUILT AND IN PRODUCTION since 2026-10-06.** This file is the
> PLAN as it was approved, kept for its reasoning. Read
> `BACKEND_STRUCTURE.md` §10.30 and §10.32 for what actually shipped.
>
> **ONE locked decision changed during the build, and this document was not
> rewritten to hide it: the transport is GMAIL, not Amazon SES.** The owner
> supplied Gmail API credentials for `spectralms@edstellar.com` instead, so
> `EMAIL_DRIVER=gmail` is what runs in production and in development. Every
> mention of SES below — the driver, `SES_REGION`, the configuration set,
> the typed exceptions, the bounce/complaint feedback loop — describes a
> path that was built and is NOT the one in use.
>
> The architecture around it is unchanged and was worth the writing: the
> outbox is still the message store, pg-boss is still only the clock, the
> worker is still a separate pm2 process, and the retry classification
> still has the same three shapes. Only the thing at the far end differs.
>
> **The one consequence that bites.** SES feeds bounces and complaints back
> through SNS, which is what `POST /api/email/ses-events` consumes and what
> fills the suppression list. Gmail does not, and that endpoint is dead
> under this driver — so `sent` means Gmail ACCEPTED the message and
> nothing downstream of that reaches us. The admin Email Delivery page
> (§10.32) therefore says "Handed to Gmail" and never "Delivered", and
> wiring Gmail's own bounce handling is the open work.
>
> Schema changes in §3 were a **human checkpoint** and have been applied.
>
> Four decisions were locked by the owner: **Amazon SES** (superseded —
> Gmail), **all 25 notification types**, **pg-boss on the existing
> Postgres**, **a separate pm2 worker process**.

---

## 1. Goal

The product has **no mail transport at all** — verified by repo-wide grep: no
nodemailer, SES, SMTP, template engine or mail config anywhere, and no
`.env` key for one. Three consequences are live today:

- **There is no forgot-password flow.** A learner who forgets theirs needs an
  admin to set a new one and read it out. `BACKEND_STRUCTURE.md` §10.3.1.11
  records the temporary password being shown unmasked for exactly this reason.
- **`manager_nudge` is a bell notification and nothing else**, because §10.22
  says "this product has no mail transport, and a button that silently sends
  nothing is worse than no button".
- **`course_due_soon` is a defined notification type with zero call sites.** It
  cannot fire, because nothing in this codebase runs on a clock.

Every notification already written to the bell should also be able to reach an
inbox — without changing any of the 25 call sites, without blocking an API
request on SMTP, and without the first production deploy mailing 500 learners
by accident.

### Why an outbox rather than enqueuing jobs directly

`notify()` writing the bell row and publishing a job are two systems. The
transaction can roll back with the job already queued (an email about something
that never happened), or commit with the publish lost (a silent drop). An
outbox row is **a row**, written by the same database in the same place, so
neither is possible.

pg-boss is therefore the **scheduler and the single-consumer lock**, not the
message store. `email_outbox` is the message store. State this in the module
docblock or it reads as a mistake.

### Why not BullMQ — measured, not assumed

| Measured on the prod box | Consequence |
|---|---|
| Redis **is** installed and running (127.0.0.1:6379, auth on, 16 DBs) | it was the obvious choice |
| …but has **persistence disabled** — `appendonly no`, no `save` lines | **every queued job is lost on restart.** Fixing it means enabling AOF on a Redis the Rails and Laravel apps also use |
| The Laravel CMS worker beside it runs `QUEUE_CONNECTION=database` | Redis is uncontended — no key collision either way |
| Postgres **18.4**, colocated on the same box | well above pg-boss's floor, and the queue poll never leaves the machine |
| `edstellar_lms_user` has `CREATE` on the database, is not superuser | **pg-boss can create its `pgboss` schema.** Verified, not assumed |
| 2 vCPU / 7.8 GB, ~5.6 GB free, shared with Postgres + Rails/Puma + a PHP worker + 5 pm2 node apps | a worker costs ~150 MB; a second datastore to keep alive costs more |

Postgres is already there, already durable, already backed up. The outbox also
buys the transactional property above, which Redis structurally cannot.

---

## 2. Scope

**In scope**

- `email_outbox`, `email_suppressions`, `user_email_preferences`, and one
  column on `organizations` (migration `0037`).
- An `email` field on all 25 entries of `NOTIFICATION_TYPES`.
- An email channel inside `NotificationsService.notify()` — **zero call-site
  changes**.
- Three mailer drivers (`log` / `file` / `ses`) behind one interface.
- A second pm2 process from the same build (`WORKER=1`) running pg-boss.
- Unsubscribe + a five-checkbox preference screen.
- SNS bounce/complaint ingestion.
- A read-only `scripts/verify-email.mjs`.

**Out of scope — and each of these is deliberate**

- **`course_due_soon` and any nightly sweep.** This work hands the codebase its
  first scheduler. A nightly "your course is due" pass across every active
  assignment in every tenant is, by an order of magnitude, the largest email
  volume this system will ever produce. Separate change, after production SES
  access is granted.
- **A forgot-password flow.** It is the single highest-value thing email
  unlocks, but it is an auth feature with its own token lifecycle and its own
  spec. This work makes it possible; it does not build it.
- **Moving bulk upload to the worker.** Related and tempting — see §8 risk 7.
- **Per-type preferences.** 25 × 4 is a 100-cell matrix nobody maintains. §5.

---

## 3. Data model

Migration `server/src/database/migrations/0037_email_outbox.sql`. Additive and
idempotent, per §6.2. The header comment carries the argument, as every
migration here does.

### `email_outbox`

Stands alone, with `notification_id integer REFERENCES notifications(id) ON
DELETE SET NULL` for forensics only — **never a NOT NULL FK**. A shared
transaction would let an outbox failure roll back the bell rows, destroying the
§10.18 contract that telling somebody is secondary to the thing.

| Column | Notes |
|---|---|
| `id` | `bigserial` PK |
| `organization_id`, `user_id` | NOT NULL, both `ON DELETE CASCADE` |
| `notification_id` | nullable, `ON DELETE SET NULL` |
| `type`, `policy` | catalogue key; `transactional` \| `announcement`, frozen |
| `to_email`, `to_name`, `org_name` | **frozen at enqueue** |
| `subject`, `body`, `link`, `actor_name` | copied from the bell row |
| `dedupe_key` | NOT NULL, unique |
| `status` | `pending` \| `sending` \| `sent` \| `failed` \| `suppressed` |
| `attempts`, `next_attempt_at`, `claimed_at`, `last_error` | retry state |
| `provider_message_id` | SES `MessageId` — the only SNS correlation key |
| `enqueued_at`, `sent_at` | |

**`to_email` and `org_name` are frozen at enqueue**, for the same reason
`actor_name` is denormalised onto `notifications`: joining to `users.email` at
send time silently retargets queued mail when somebody corrects their address,
and leaves the delivery log unable to say where the message actually went.

Indexes — partial, the same instinct as `idx_notifications_unread`, because the
hot predicates all cover a tiny slice of a table that grows forever:

```
UNIQUE (dedupe_key)
(next_attempt_at, id)   WHERE status = 'pending'
(claimed_at)            WHERE status = 'sending'
(sent_at)               WHERE status = 'sent'
(user_id, enqueued_at DESC)
(provider_message_id)   WHERE provider_message_id IS NOT NULL
```

### `email_suppressions`

`email` PK (lowercased), `reason` (`hard_bounce` \| `complaint` \| `manual`),
`detail`, `created_at`.

Deliberately **global — no `organization_id`, no `user_id`.** A hard bounce is a
fact about an address, not about a tenant or an account. The same address at two
tenants bounces at both.

### `user_email_preferences`

`user_id` PK `ON DELETE CASCADE`, `all_off boolean DEFAULT false`,
`groups_off text[] DEFAULT '{}'`, `updated_at`.

An absent row means everything on, so there is no backfill and no insert for
existing users.

### `organizations.email_announcements boolean NOT NULL DEFAULT false`

Defaults **false**. The single safety valve between the first deploy and 500
unsolicited emails. §5 argues it.

### Not here

pg-boss creates its own `pgboss` schema on `boss.start()`. Do **not** add it to
`0037`.

---

## 4. API contract

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| `GET` | `/api/auth/email-preferences` | any role | — | `{ all_off, groups_off[] }` |
| `PATCH` | `/api/auth/email-preferences` | any role | `{ all_off?, groups_off? }` | `{ preferences }` |
| `GET` | `/api/email/unsubscribe` | `@Public()` | `?t=<hmac>` | a confirmation page |
| `POST` | `/api/email/unsubscribe` | `@Public()` | `?t=<hmac>` | `{ ok: true }` — RFC 8058 one-click |
| `POST` | `/api/email/ses-events` | `@Public()` | SNS envelope | `{ ok: true }` |
| `GET` | `/api/platform/email/outbox` | `@PlatformAdmin()` | paginated filters | `{ rows, total }` |

**The unsubscribe token is a stateless HMAC** over `JWT_SECRET`:
`base64url(userId.purpose.HMAC_SHA256(userId.purpose, JWT_SECRET))`. No table,
no column, no migration, revocable by rotating the secret, and **no expiry** —
an unsubscribe link in a two-year-old email that fails is a complaint.

**`POST /api/email/ses-events` must verify the SNS signature.** An
unauthenticated endpoint that writes to the suppression list is a
denial-of-service primitive: anyone who finds the URL could suppress every
admin's address. Validate `SigningCertURL` is an `amazonaws.com` host and check
the signature *before* reading the body. This is the most security-sensitive
code in the spec.

`GET /api/platform/email/outbox` is not optional polish — without it, every
"did my learner get the email?" is an SSH session.

---

## 5. UI

Small, and almost all of it is one screen.

- **Preference screen** in `client/components/shared/my-profile-dialog.jsx` —
  all four portals already share it. One master switch plus five checkboxes
  over the catalogue's existing `group`. Each group states, in words,
  *"Decisions about your account are always sent."*
- **`client/lib/notifications.js`** mirrors the new `email` field, because it is
  what renders that copy. The catalogue's own rule is that a field exists only
  because something reads it; here two things do.
- **An unsubscribe landing page** — public, no shell, no auth.

### The preference model, and why it is three levers and not a hundred

1. **`all_off` is honoured for everything, transactional included.** Partial
   honouring makes the checkbox a lie, and a lie in a consent UI is worse than
   an annoyed learner. This is affordable *here specifically* because §10.18
   already guarantees nothing in the notification system may be the only way a
   person learns something — the data is on their screens regardless. Email
   inherits that invariant, so "off" can mean off.
2. **`groups_off` is honoured for `announcement` types only.** Five checkboxes.
   A 26th notification type slots into an existing group with no UI change and
   no migration — which is exactly why `group` is the right key and `type` is
   not.
3. **The suppression list is not a preference.** A hard block outranking every
   user and org setting. It is what protects the SES account.

### The one scope addition this spec recommends

The two open-enrolment types should **additionally** require a per-action
opt-in: a checkbox on the course and session forms reading *"Email the 487
learners who don't have this course"*, **unticked by default**, with the live
recipient count rendered.

PECR treats B2B mail to a corporate subscriber as defensible without prior
consent, so this is not a legal blocker — but "a course is open to join", sent
unsolicited to 500 people who did not ask for that specific course, is the
message most likely to generate a spam complaint, and complaints damage
deliverability for the other 24 types. That one checkbox is simultaneously the
legal safeguard, the deliverability safeguard, and the don't-surprise-a-
customer's-500-employees safeguard.

**This is beyond the four agreed decisions and touches the client.** Flagged
rather than assumed.

---

## 6. Acceptance criteria

1. `npm run typecheck` passes with `email` required on all 25 catalogue
   entries — the `as const satisfies Record<string, NotificationTypeDef>`
   assertion makes a 26th type a **compile error** until somebody decides.
2. **Zero of the 25 `notify()` call sites change.** `git diff --stat` touches
   `notifications.service.ts`, `notifications.repository.ts` and
   `notifications.module.ts` only.
3. `notify()` still never throws, and an email failure logs under its **own**
   message — not "Notification not sent", which would be a lie in a log.
4. If the bell insert fails, the email is still attempted. Independent channels.
5. A 500-recipient fan-out costs **one** gate query and **one** outbox INSERT.
6. With `EMAIL_ENABLED=false`, no outbox row is written and no behaviour changes.
7. A learner with `all_off` gets a bell row and **no** outbox row. That
   asymmetry is the point of gating at enqueue.
8. A course named `<b>Safety</b>` renders as literal text in the email body.
9. Every link in a sent email is absolute and resolves.
10. `kill -9` mid-drain produces **zero** duplicate `sent` rows, and the
    orphaned `sending` row returns to `pending` within the reaper window.
11. Two pm2 processes booting simultaneously both complete migrations without
    error (the advisory lock).
12. The API process never opens a pg-boss connection.

### 6a. End-to-end user journeys

- **Happy path.** As an admin, I assign a course to a learner in the real admin
  UI → within 60s that learner has a bell notification *and* an email whose
  subject is identical to the bell's title, whose CTA opens the course, and
  whose footer names their organization.
- **Opt-out.** As a learner, I click "Unsubscribe" in an email → I land on a
  public confirmation page → the next assignment gives me a bell row and no
  email.
- **Bounce.** A hard bounce arrives via SNS → the address lands in
  `email_suppressions` → no further row is ever sent to it, transactional
  included.
- **Trigger for every endpoint.** `email-preferences` is called by the profile
  dialog; `unsubscribe` by the footer link and the `List-Unsubscribe` header;
  `ses-events` by the SNS subscription; `platform/email/outbox` by the platform
  admin screen. No endpoint without a caller.

---

## 7. Human checkpoints

1. **Migration `0037`** — four objects, one of them altering `organizations`.
2. **SES production access** — request on **day 1 of the build**, not day 1 of
   launch. It needs a written use case and takes ~24h. ap-south-1 production
   defaults are 50,000/day and 14/sec; sandbox is 1/sec, 200/day, and every
   recipient must be a verified identity.
3. **SPF / DKIM / DMARC on the sending domain**, verified with mail-tester
   *before* any real recipient. A missing DKIM is how a fan-out lands in Junk
   with nobody reporting it.
4. **The allowlist census.** Run `EMAIL_DRIVER=ses` with
   `EMAIL_ALLOWLIST=<three internal addresses>` for a week. Every other row is
   written `suppressed/not_allowlisted`, giving a complete production census
   with zero mail to learners. `SELECT type, policy, count(*) … GROUP BY 1,2`
   then answers "how much mail is this actually going to send" with data rather
   than a guess. **This is the most important step in the rollout.**
5. **Turning `email_announcements` on**, one tenant at a time.
6. The §5 per-action opt-in checkbox — an explicit yes or no.

---

## 8. Non-goals and risks

1. **`CLIENT_ORIGIN` defaults to `http://localhost:3000`** in
   `configuration.ts`, and `link` is relative throughout. Misconfigured, that
   is 500 unrecallable dead links. **Hard-fail in the worker:** if the driver is
   `ses` and the origin is localhost, mark rows `failed` and log at `error`.
   Sending nothing beats sending garbage.
2. **No bounce handling at launch → account suspension.** Mitigated week 1, free
   and with zero code, by an SES **Configuration Set with account-level
   suppression** for `BOUNCE` and `COMPLAINT`. Fixed properly by SNS in week 2.
   The allowlist buys the time.
3. **The migration race.** `runMigrations` has **no advisory lock** today.
   Concurrent `CREATE TABLE IF NOT EXISTS` can raise a duplicate-key error on
   `pg_type`, and concurrent `CREATE INDEX IF NOT EXISTS` on one relation can
   deadlock. This is a **real bug now** — `main.ts` already contemplates a
   second API instance. Fix it first, as its own commit. Do *not* solve it with
   `MIGRATE=0` on the worker; that silently means nobody migrates if the worker
   boots first.
4. **Unescaped `title`/`body`** → HTML injection into every recipient's inbox.
   Course names are user input and are already interpolated with quotes.
5. **Cluster mode on the worker** doubles the send rate and blows the SES quota.
   `instances: 1`, with the reason written in `ecosystem.config.js`.
6. **Delivery is at-least-once.** A crash between SES accepting and the status
   UPDATE yields exactly one duplicate. Write this in the docblock — exactly-once
   email does not exist, and pretending otherwise produces designs that drop
   mail instead.
7. **Bulk upload still freezes the whole API, and a worker does not fix it.**
   `users.service.ts:510` calls `scryptSync` per row for up to 500 rows; it is
   synchronous and CPU-bound, so the single-process API serves nobody for the
   duration. The cheap fix is async `scrypt`, which yields between rows and
   changes no UX. Out of scope, worth knowing.
8. **"All 25 types" means the mapping covers 25, not that 25 will send.**
   `journey_assigned`, `course_due_soon` and `session_cancelled` have zero call
   sites today.

---

## 9. Implementation order

Each commit is independently deployable and the first three change no behaviour.

| # | What | Files |
|---|---|---|
| 1 | **Advisory lock** — ship alone, first | `src/database/migration.runner.ts` |
| 2 | Catalogue `email` field + `email` config namespace | `src/common/notifications.ts`, `src/config/configuration.ts`, `client/lib/notifications.js` |
| 3 | Migration `0037` | `src/database/migrations/0037_email_outbox.sql` |
| 4 | Enqueue side — deploy with `EMAIL_ENABLED=false` | `src/modules/email/*`, `notifications.{service,repository,module}.ts` |
| 5 | Rendering + the three mailers | `src/modules/email/{email-render.service.ts,templates/,mailer/}` |
| 6 | The worker | `src/worker.ts`, `src/worker.module.ts`, `src/main.ts`, `src/modules/email/queue/*`, `ecosystem.config.js` |
| 7 | Preferences, unsubscribe, platform read | `src/modules/email/{email.controller.ts,dto/,unsubscribe-token.ts}`, `client/components/shared/my-profile-dialog.jsx` |
| 8 | Verifier | `scripts/verify-email.mjs` |
| 9 | SNS ingestion, with signature verification | `src/modules/email/ses-events.controller.ts` |
| 10 | `BACKEND_STRUCTURE.md` §10.30 | not optional in this codebase |

### Module wiring

`EmailModule` imports nothing, so `NotificationsModule` can import it without
becoming cyclic — the same property that lets `NotificationsModule` be imported
by eleven modules. It is **not** `@Global()`, because `DatabaseModule`'s own
docblock claims to be the only global module and that is worth keeping true. It
exports `EmailOutboxService` only (§3.2): a module inserting straight into
`email_outbox` would bypass the gate.

### The two edits inside `notify()`

```ts
let ids: number[] = [];
try { ids = await this.repository.insert(entries); }       // now RETURNING id
catch (e) { this.logger.warn(`Notification not sent (${input.type}): …`); }
await this.email.enqueue(input, entries, ids);             // never throws, own logger
```

`EmailOutboxService.enqueue()` carries the identical never-throws contract by
**duplicating the discipline, not by nesting** — its own try/catch, its own
Logger, its own message.

`NotifyInput` gains three optional fields (`emailSubject?`, `emailBody?`,
`email?: 'auto' | 'never'`) with zero uses, so all 25 call sites compile
untouched. `notifyOnce()` needs no change.

### The gate, at enqueue, cheapest first

One query over `users`, `organizations`, `user_email_preferences` and
`email_suppressions` with `WHERE u.id = ANY($1)` — one round trip for a
500-person fan-out, matching the one-multi-row-statement rule the repository
already keeps:

`EMAIL_ENABLED` → policy ≠ `none` → org active (+ `email_announcements` for
announcements) → user active, has an address, not `all_off`, group not in
`groups_off` → not suppressed.

Do **not** write `suppressed` rows for people who merely opted out — that is 500
rows of nothing per fan-out. Only the allowlist writes them, because their whole
purpose is to be counted.

`dedupe_key = sha256(type:userId:subjectType:subjectId:floor(now/5min))`,
inserted `ON CONFLICT DO NOTHING`. It kills double-submits and cannot plausibly
suppress a genuinely intended second message — nobody assigns the same course to
the same person twice inside five minutes on purpose.

**Fan-out ceiling — skip, never truncate.** Above
`EMAIL_MAX_RECIPIENTS_PER_NOTIFY`, skip the email for that call entirely, log one
`error` naming type/org/count, and still write every bell row. Truncation tells
some learners and not others, with no way to know which, and is discovered weeks
later.

### Rendering

**Reuse the stored `title`/`body`. Do not write 25 templates.** They were
composed at write time by the service holding the course and the actor, as a
complete sentence pair for a human. Twenty-five templates would be a second
place wording lives, built in a different process minutes later from data that
may since have been renamed — the exact failure the denormalised columns exist
to prevent.

Subject = `title` verbatim, no `[Edstellar]` prefix (it burns inbox preview
width and reads as bulk). Preheader = `body`. One table-based layout, inline
CSS, ~600px, system fonts, no external images, always multipart.

Three further traps: **do not use the catalogue's `icon`** (a lucide component
name with no server-side renderer); **no presigned R2 URL in an email**
(`videoUrlTtlSeconds` is 900s, so it 404s before most people open it); and
absolutise links with `new URL(link, clientOrigin)` guarded against values that
are already absolute.

### Transport

Build raw MIME with `nodemailer`'s `MailComposer` and send via **SESv2
`SendEmail` over HTTPS**, not SMTP. Three reasons, and the first is the one that
matters: the box is EC2 in ap-south-1, so it can use an **IAM instance role and
hold no SES credential in `.env` at all**. Also, `SendEmail` returns the
`MessageId` synchronously — the only SNS correlation key — and structured
exception types make the retry classification below possible, where SMTP gives
you a number and a string. Port 587 is open and remains a documented fallback.

New deps: `@aws-sdk/client-sesv2` (same family and version line as the present
`client-s3`), `nodemailer`, `@types/nodemailer`, `pg-boss`.

### The worker

`main.ts` forks in four lines at the top of `bootstrap()`:

```ts
if (process.env.WORKER === '1') { await bootstrapWorker(); return; }
```

— rather than threading `if`s through the existing 130-line bootstrap with its
SCORM middleware ordering comments.

`NestFactory.createApplicationContext(WorkerModule)`: **no Express instance is
ever created**, which is the real answer to "no HTTP listener". `WorkerModule`
imports `ConfigModule.forRoot` (identical options), `DatabaseModule` and
`EmailModule` — **not `AppModule`**, which would drag in 25 feature modules and
four global guards the worker never reaches.

**The API cannot start a consumer**, because `queue/pg-boss.service.ts` is
provided only by `WorkerModule`. Structural, not merely discouraged.

Two jobs: a one-minute drain
(`singletonKey: 'drain'`, `singletonSeconds: 55`) and a 3am prune of
`sent`/`suppressed` rows older than 90 days.

```sql
UPDATE email_outbox SET status='sending', attempts=attempts+1, claimed_at=now()
 WHERE id IN (SELECT id FROM email_outbox
               WHERE status='pending' AND next_attempt_at <= now()
               ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
 RETURNING *;
```

`FOR UPDATE SKIP LOCKED` is non-negotiable — it makes a second worker harmless
even if pm2 is misconfigured. `attempts` increments **at claim**, not at
failure, so a row that crashes the worker repeatedly eventually gives up instead
of looping forever.

Reaper at the top of every tick: `status='sending' AND claimed_at < now() -
interval '10 minutes'` → back to `pending`. That is what recovers a `kill -9`.

Shutdown: `OnApplicationShutdown` → `boss.stop({ graceful: true })`, plus a
`stopping` flag checked between messages so SIGTERM finishes the in-flight send
and leaves the rest to the reaper. `kill_timeout: 30000`.

### Retry classification

The distinction that matters is that **throttling is not a message failure**.

| SES condition | Action |
|---|---|
| `AccountSendingPausedException` | **Abort the whole tick.** Log `error`. Hammering a troubled account makes it worse |
| `ThrottlingException` | Back to `pending`, **do not** increment `attempts`, back off the loop |
| `MessageRejected` (unverified address) | `failed`, no retry — in sandbox this is every real learner |
| `MailFromDomainNotVerified`, config-set errors | `failed`, log at **`error`** — a human must act |
| Network / 5xx | Retryable. 1m, 5m, 25m, 2h, 10h. `MAX_ATTEMPTS = 5` |

A successful `SendEmail` means SES **accepted** it. Delivery, bounce and
complaint are asynchronous and arrive via SNS.

---

## 10. Config

New `email` namespace in `src/config/configuration.ts` — still the only
`process.env` reader. **Every default is the sandbox value**, so a misconfigured
production is slow rather than catastrophic.

| var | default |
|---|---|
| `EMAIL_ENABLED` | `false` |
| `EMAIL_DRIVER` | `log` (`log` \| `file` \| `ses`) |
| `EMAIL_RATE_PER_SECOND` | `1` |
| `EMAIL_MAX_PER_DAY` | `200` |
| `EMAIL_BATCH_SIZE` | `25` |
| `EMAIL_ALLOWLIST` | *(empty)* |
| `EMAIL_MAX_RECIPIENTS_PER_NOTIFY` | `200` |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`, `SES_REGION`, `SES_CONFIGURATION_SET` | — |

**Nothing is added to `REQUIRED` in `env.validation.ts`.** Follow the
`media/storage/r2-storage.service.ts:50-82` precedent exactly: collect the
missing names at construction, log one warn at boot naming them and saying the
process must be restarted, and degrade. A new hard boot requirement would make
email a dependency of every endpoint — the mistake the R2 work deliberately
avoided.

Pacing is `await sleep(1000 / ratePerSecond)` inside the drain loop. No library;
a single-instance worker makes that exactly correct. The daily budget is one
indexed count per tick, served by the partial `(sent_at) WHERE status='sent'`
index — note in a comment that it is a UTC day while SES's quota is a rolling
24h, so nobody "fixes" it later.

---

## 11. Verification

Per `AGENTS.md`, a green build proves only that it compiles. Drive the real UI.

**Locally, with no AWS account** — this is what the three drivers buy:

```bash
npm run build
node dist/main                                            # API
WORKER=1 EMAIL_DRIVER=file EMAIL_ENABLED=true node dist/main   # worker
```

1. Assign a course to a seeded learner **through the admin UI**.
2. One `pending` row; `subject` identical to the bell's `title`.
3. Within 60s: `sent`, with `sent_at` and `provider_message_id` set.
4. Open the `.eml` from `storage/outbox/`: CTA absolute and resolving, footer
   correct for the policy, and a course named `<b>Safety</b>` rendering as
   literal text.
5. Unsubscribe, re-assign: **no new outbox row, a new bell row**.
6. `kill -9` the worker mid-drain and restart: no duplicate `sent` rows; the
   orphaned row returns to `pending` after the reaper window.

**`npm run email:verify`** — read-only, no `--commit`, safe against production
at any time, following `scripts/verify-rbac.mjs` exactly. Checks: `0037`
applied; `pgboss` schema present; env var **names** present (never values);
origin is not localhost under `ses`; allowlist set under `ses`; 24h status
counts; **age of the oldest `pending` row** — the alarm for a dead worker;
suppression count; the 10 most recent distinct `last_error` values. The smoke
test and the on-call runbook in one file.

**Production rollout** is §7's checkpoints, in order: deploy disabled → verify
DKIM → allowlist census for a week → one pilot tenant → remove the allowlist →
announcements on, one tenant at a time. Bounce rate under 5%, complaints under
0.1%.
