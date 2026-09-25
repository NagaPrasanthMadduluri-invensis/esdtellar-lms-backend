import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { FEEDBACK_ELIGIBLE_ATTENDANCE } from '@/common/feedback';

/**
 * `('present', 'late', 'partial')` as a real IN list.
 *
 * Drizzle expands a JS array into a ROW constructor, so a bare
 * `IN ${ARRAY}` becomes `IN (('present','late','partial'))` and Postgres
 * rejects it. The same quirk `idList()` exists for in three other
 * repositories — this is the text-valued version of it.
 */
const ELIGIBLE_ATTENDANCE: SQL = sql`(${sql.join(
  FEEDBACK_ELIGIBLE_ATTENDANCE.map((s) => sql`${s}`),
  sql`, `,
)})`;

/**
 * Every query over `session_feedback`.
 *
 * ONE RULE GOVERNS THIS FILE: a method whose caller is a trainer must not
 * select `user_id`, and must not join anything that would reveal it. The
 * trainer-facing methods below name their columns explicitly and are grouped
 * under their own heading so the rule is visible rather than remembered.
 * §3.1 already requires explicit column lists everywhere; here a `SELECT *`
 * would not merely over-fetch, it would break a promise made to the learner
 * on the form.
 *
 * Every read is org-scoped first and then narrowed to the trainer's own
 * sessions in SQL, for the reason `SessionsRepository` already documents: a
 * session that is not theirs must be indistinguishable from one that does
 * not exist, or the 404 becomes a way to enumerate other trainers' work.
 */
/** Shapes the raw-SQL reads return. snake_case, because raw SQL is (§10.10). */
export interface LearnerFeedbackRow {
  session_id: number;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  session_type: string;
  trainer_name: string | null;
  status: string;
  attendance: string;
  feedback_id: number | null;
  rating_content: number | null;
  rating_trainer: number | null;
  rating_delivery: number | null;
  comment: string | null;
  submitted_at: string | null;
}

export interface TrainerSummaryRow {
  session_id: number;
  title: string;
  date: string;
  session_type: string;
  status: string;
  course_name: string | null;
  eligible: number;
  responses: number;
  avg_content: string | null;
  avg_trainer: string | null;
  avg_delivery: string | null;
  latest_at: string | null;
}

export interface TrainerResponseRow {
  id: number;
  session_id: number;
  session_title: string;
  session_date: string;
  rating_content: number;
  rating_trainer: number;
  rating_delivery: number;
  comment: string | null;
  created_at: string;
}

@Injectable()
export class FeedbackRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Is this session one the trainer runs, and is it finished?
   *
   * Matches `session_batches.trainer_user_id` as well as the session's own
   * column: a trainer can be assigned to a single sitting of a multi-batch
   * session, and one that only checked `sessions.trainer_user_id` would hide
   * their own work from them.
   */
  private trainerOwns(trainerUserId: number) {
    return sql`(
      s.trainer_user_id = ${trainerUserId}
      OR EXISTS (
        SELECT 1 FROM session_batches b
         WHERE b.session_id = s.id AND b.trainer_user_id = ${trainerUserId}
      )
    )`;
  }

  /* ── Learner side ────────────────────────────────────────────────────── */

  /**
   * One row saying whether this learner may rate this session, and whether
   * they already have — in a single round trip (§7.1, §7.5).
   *
   * Three facts the form needs, and fetching them separately would let the
   * page render a form for a session that had since been cancelled.
   * `attended` reuses the three statuses that credit the training (§10.7)
   * rather than a second definition of "was in the room".
   */
  async eligibility(scope: OrgScope, sessionId: number, userId: number) {
    const rows = await this.db.all<{
      session_id: number;
      title: string;
      date: string;
      status: string;
      trainer_name: string | null;
      attended: string | null;
      existing_id: number | null;
    }>(sql`
      SELECT s.id AS session_id, s.title, s.date, s.status,
             s.trainer AS trainer_name,
             (SELECT sa.status FROM session_attendance sa
               WHERE sa.session_id = s.id AND sa.user_id = ${userId}) AS attended,
             (SELECT f.id FROM session_feedback f
               WHERE f.session_id = s.id AND f.user_id = ${userId}) AS existing_id
        FROM sessions s
       WHERE s.id = ${sessionId} AND ${orgScope('s', scope)}
    `);
    return rows[0] ?? null;
  }

  /**
   * Every session this learner attended, with whether they have rated it.
   *
   * One query for the whole "Give feedback" list, never one per session
   * (§7.1). `LEFT JOIN` rather than a subquery per column because three of
   * the selected fields come from the same optional row.
   */
  async pendingForLearner(scope: OrgScope, userId: number) {
    return this.db.all<LearnerFeedbackRow>(sql`
      SELECT s.id AS session_id, s.title, s.date, s.start_time, s.end_time,
             s.session_type, s.trainer AS trainer_name, s.status,
             sa.status AS attendance,
             f.id AS feedback_id,
             f.rating_content, f.rating_trainer, f.rating_delivery,
             f.comment, f.created_at AS submitted_at
        FROM session_attendance sa
        JOIN sessions s ON s.id = sa.session_id
        LEFT JOIN session_feedback f
               ON f.session_id = s.id AND f.user_id = ${userId}
       WHERE sa.user_id = ${userId}
         AND ${orgScope('sa', scope)}
         AND sa.status IN ${ELIGIBLE_ATTENDANCE}
         AND s.status = 'completed'
       ORDER BY s.date DESC, s.start_time DESC
    `);
  }

  async create(input: {
    organizationId: number;
    sessionId: number;
    userId: number;
    ratingContent: number;
    ratingTrainer: number;
    ratingDelivery: number;
    comment: string | null;
  }) {
    // Raw SQL, and `RETURNING` names the same snake_case the reads use. A
    // Drizzle `.returning()` here would hand the caller camelCase while every
    // read in this file is snake_case — the §10.10 defect, seven times now.
    const rows = await this.db.all(sql`
      INSERT INTO session_feedback
        (organization_id, session_id, user_id,
         rating_content, rating_trainer, rating_delivery, comment)
      VALUES
        (${input.organizationId}, ${input.sessionId}, ${input.userId},
         ${input.ratingContent}, ${input.ratingTrainer},
         ${input.ratingDelivery}, ${input.comment})
      ON CONFLICT (session_id, user_id) DO UPDATE
        SET rating_content  = EXCLUDED.rating_content,
            rating_trainer  = EXCLUDED.rating_trainer,
            rating_delivery = EXCLUDED.rating_delivery,
            comment         = EXCLUDED.comment,
            created_at      = now()
      RETURNING id, session_id, rating_content, rating_trainer,
                rating_delivery, comment, created_at
    `);
    return rows[0];
  }

  /** Did a row already exist before that upsert? Decides notify vs stay quiet. */
  async exists(sessionId: number, userId: number) {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM session_feedback
       WHERE session_id = ${sessionId} AND user_id = ${userId}
    `);
    return rows.length > 0;
  }

  /**
   * Who to tell that feedback arrived: the session's trainer, plus any
   * batch trainers.
   *
   * Returns ids only. The notification it feeds names no author (see
   * `FeedbackService.announce`), so nothing here leaks the learner.
   */
  async trainerIdsFor(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{ trainer_user_id: number }>(sql`
      SELECT s.trainer_user_id
        FROM sessions s
       WHERE s.id = ${sessionId} AND ${orgScope('s', scope)}
         AND s.trainer_user_id IS NOT NULL
      UNION
      SELECT b.trainer_user_id
        FROM session_batches b
       WHERE b.session_id = ${sessionId} AND ${orgScope('b', scope)}
         AND b.trainer_user_id IS NOT NULL
    `);
    return rows.map((r) => Number(r.trainer_user_id));
  }

  /* ── Trainer side — NO `user_id` BELOW THIS LINE ─────────────────────── */

  /**
   * Per-session totals across every session this trainer runs.
   *
   * One query for the whole page (§7.1): a trainer with 30 sessions costs one
   * round trip, not 30. `eligible` is how many people COULD have answered,
   * which is what makes a response rate meaningful — "4 responses" says
   * nothing without it.
   */
  async summaryForTrainer(scope: OrgScope, trainerUserId: number) {
    return this.db.all<TrainerSummaryRow>(sql`
      SELECT s.id AS session_id, s.title, s.date, s.session_type, s.status,
             c.name AS course_name,
             (SELECT COUNT(*) FROM session_attendance sa
               WHERE sa.session_id = s.id
                 AND sa.status IN ${ELIGIBLE_ATTENDANCE}) AS eligible,
             COUNT(f.id)                        AS responses,
             AVG(f.rating_content)::numeric(3,2)  AS avg_content,
             AVG(f.rating_trainer)::numeric(3,2)  AS avg_trainer,
             AVG(f.rating_delivery)::numeric(3,2) AS avg_delivery,
             MAX(f.created_at)                  AS latest_at
        FROM sessions s
        LEFT JOIN courses c ON c.id = s.course_id
        LEFT JOIN session_feedback f ON f.session_id = s.id
       WHERE ${orgScope('s', scope)}
         AND ${this.trainerOwns(trainerUserId)}
         AND s.status = 'completed'
       GROUP BY s.id, s.title, s.date, s.session_type, s.status, c.name
       ORDER BY s.date DESC
    `);
  }

  /**
   * The individual responses, anonymised.
   *
   * No `user_id`, no join to `users`, and no `created_at` finer than the row
   * itself — note that ordering by `created_at` is still safe because the
   * trainer cannot see the attendance timestamps to correlate against.
   * `sessionId` is optional so the same method serves "all my feedback" and
   * one session's detail without a second query to maintain.
   */
  async listForTrainer(
    scope: OrgScope,
    trainerUserId: number,
    sessionId: number | null,
    limit: number,
    offset: number,
  ) {
    const onlyOne = sessionId
      ? sql`AND s.id = ${sessionId}`
      : sql``;
    return this.db.all<TrainerResponseRow>(sql`
      SELECT f.id, f.session_id, s.title AS session_title, s.date AS session_date,
             f.rating_content, f.rating_trainer, f.rating_delivery,
             f.comment, f.created_at
        FROM session_feedback f
        JOIN sessions s ON s.id = f.session_id
       WHERE ${orgScope('f', scope)}
         AND ${this.trainerOwns(trainerUserId)}
         ${onlyOne}
       ORDER BY f.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `);
  }

  /** Total matching rows, so the page can say "showing 20 of 84" (§7.6). */
  async countForTrainer(
    scope: OrgScope,
    trainerUserId: number,
    sessionId: number | null,
  ) {
    const onlyOne = sessionId ? sql`AND s.id = ${sessionId}` : sql``;
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
        FROM session_feedback f
        JOIN sessions s ON s.id = f.session_id
       WHERE ${orgScope('f', scope)}
         AND ${this.trainerOwns(trainerUserId)}
         ${onlyOne}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** How many completed sessions this trainer has, for the empty state. */
  async completedSessionCount(scope: OrgScope, trainerUserId: number) {
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
        FROM sessions s
       WHERE ${orgScope('s', scope)}
         AND ${this.trainerOwns(trainerUserId)}
         AND s.status = 'completed'
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** Feedback this learner has given, for the `feedback_hero` badge. */
  async countByUser(userId: number) {
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
        FROM session_feedback WHERE user_id = ${userId}
    `);
    return Number(rows[0]?.total ?? 0);
  }
}
