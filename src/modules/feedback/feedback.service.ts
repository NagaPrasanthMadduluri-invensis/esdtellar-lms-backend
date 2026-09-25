import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  FEEDBACK_ELIGIBLE_ATTENDANCE,
  MIN_RESPONSES_FOR_AVERAGE,
} from '@/common/feedback';
import { type OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { FeedbackRepository } from './feedback.repository';
import { SubmitFeedbackDto } from './dto/feedback.dto';

/** pg hands `numeric` back as a STRING (§10.17). Convert once, here. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const ELIGIBLE: readonly string[] = FEEDBACK_ELIGIBLE_ATTENDANCE;

@Injectable()
export class FeedbackService {
  constructor(
    private readonly repository: FeedbackRepository,
    private readonly notifications: NotificationsService,
  ) {}

  /* ── Learner ─────────────────────────────────────────────────────────── */

  /**
   * Every completed session this learner attended, and what they said about
   * each — the list behind "Give feedback".
   *
   * Only sessions they were marked present, late or partial for appear. That
   * is the same set that credited them for the training (§10.7), reused
   * rather than redefined.
   */
  async listForLearner(scope: OrgScope, userId: number) {
    const rows = await this.repository.pendingForLearner(scope, userId);
    const sessions = rows.map((r) => ({
      session_id: Number(r.session_id),
      title: r.title,
      date: r.date,
      start_time: r.start_time,
      end_time: r.end_time,
      session_type: r.session_type,
      trainer_name: r.trainer_name ?? null,
      attendance: r.attendance,
      submitted: r.feedback_id !== null && r.feedback_id !== undefined,
      feedback: r.feedback_id
        ? {
            rating_content: Number(r.rating_content),
            rating_trainer: Number(r.rating_trainer),
            rating_delivery: Number(r.rating_delivery),
            comment: r.comment ?? null,
            submitted_at: r.submitted_at,
          }
        : null,
    }));

    return {
      sessions,
      pending_count: sessions.filter((s) => !s.submitted).length,
    };
  }

  /**
   * Record one learner's rating.
   *
   * Three refusals, each stated to the caller rather than silently ignored:
   * a session that is not theirs (404, not 403 — they must not learn it
   * exists), one they did not attend, and one that has not finished.
   */
  async submit(
    scope: OrgScope,
    sessionId: number,
    user: { userId: number; firstName?: string; lastName?: string },
    dto: SubmitFeedbackDto,
  ) {
    const row = await this.repository.eligibility(scope, sessionId, user.userId);
    if (!row) throw new NotFoundException('Session not found');

    if (!row.attended || !ELIGIBLE.includes(row.attended)) {
      throw new UnprocessableEntityException(
        row.attended
          ? `Feedback is open to learners who attended. Your attendance is recorded as "${row.attended}".`
          : 'Feedback is open to learners who attended this session. Your attendance has not been marked yet.',
      );
    }

    if (row.status !== 'completed') {
      throw new UnprocessableEntityException(
        'This session is not finished yet. Feedback opens once the trainer marks it completed.',
      );
    }

    // Was there already a row? Decides whether the trainer hears about it —
    // editing your own answer is not news, and a trainer whose bell rings on
    // every edit learns to ignore it (§10.18).
    const wasUpdate = await this.repository.exists(sessionId, user.userId);

    const saved = await this.repository.create({
      organizationId: scope.organizationId,
      sessionId,
      userId: user.userId,
      ratingContent: dto.rating_content,
      ratingTrainer: dto.rating_trainer,
      ratingDelivery: dto.rating_delivery,
      comment: dto.comment ?? null,
    });

    if (!wasUpdate) await this.announce(scope, sessionId, row.title);

    return { feedback: saved, updated: wasUpdate };
  }

  /**
   * Tell the trainer a response landed — WITHOUT naming the author.
   *
   * `actorName` is deliberately left null and the body names no one. Every
   * other notification in this product carries who caused it; this is the one
   * that must not, because the notification would otherwise undo the
   * anonymity the form promised. Best-effort like every notify (§8.4).
   */
  private async announce(scope: OrgScope, sessionId: number, title: string) {
    const trainerIds = await this.repository.trainerIdsFor(scope, sessionId);
    if (trainerIds.length === 0) return;

    void this.notifications.notify({
      organizationId: scope.organizationId,
      userIds: trainerIds,
      type: 'session_feedback_received',
      title: 'New session feedback',
      body: `Someone who attended "${title}" has rated it.`,
      link: '/trainer/feedback',
      subjectType: 'session',
      subjectId: sessionId,
      // No actorName: see the docblock. Anonymous means anonymous.
    });
  }

  /* ── Trainer ─────────────────────────────────────────────────────────── */

  /**
   * The trainer's Feedback page: per-session averages plus the responses.
   *
   * Two queries for the whole page, not two per session (§7.1).
   *
   * A session with fewer than `MIN_RESPONSES_FOR_AVERAGE` responses reports
   * its averages as null and says how many it has. One 2/5 rendered as "2.0
   * average" invites a conclusion three more responses might reverse — the
   * same refusal the analytics trends make with `sufficient: false` (§10.12).
   */
  async overviewForTrainer(
    scope: OrgScope,
    trainerUserId: number,
    query: { session_id?: number; limit?: number; offset?: number },
  ) {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const sessionId = query.session_id ?? null;

    const [summaryRows, responseRows, total, completedSessions] =
      await Promise.all([
        this.repository.summaryForTrainer(scope, trainerUserId),
        this.repository.listForTrainer(
          scope,
          trainerUserId,
          sessionId,
          limit,
          offset,
        ),
        this.repository.countForTrainer(scope, trainerUserId, sessionId),
        this.repository.completedSessionCount(scope, trainerUserId),
      ]);

    const sessions = summaryRows.map((r) => {
      const responses = Number(r.responses ?? 0);
      const enough = responses >= MIN_RESPONSES_FOR_AVERAGE;
      return {
        session_id: Number(r.session_id),
        title: r.title,
        date: r.date,
        session_type: r.session_type,
        course_name: r.course_name ?? null,
        eligible: Number(r.eligible ?? 0),
        responses,
        // Withheld, not zero. "Too few to average" and "averaged badly" are
        // different facts and must not render the same.
        sufficient: enough,
        avg_content: enough ? num(r.avg_content) : null,
        avg_trainer: enough ? num(r.avg_trainer) : null,
        avg_delivery: enough ? num(r.avg_delivery) : null,
        latest_at: r.latest_at ?? null,
      };
    });

    const responded = sessions.filter((s) => s.responses > 0);
    const totalResponses = sessions.reduce((sum, s) => sum + s.responses, 0);
    const totalEligible = sessions.reduce((sum, s) => sum + s.eligible, 0);

    // The headline averages are computed over SESSIONS that have enough
    // responses, not over every row, so one heavily-answered session cannot
    // drown out five quiet ones — and so the number agrees with the cards
    // beneath it, which is the rule §10.3.1.8 records for KPI tiles.
    const scored = sessions.filter((s) => s.sufficient);
    const mean = (pick: (s: (typeof scored)[number]) => number | null) => {
      const values = scored.map(pick).filter((v): v is number => v !== null);
      if (values.length === 0) return null;
      return (
        Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) /
        100
      );
    };

    return {
      summary: {
        completed_sessions: completedSessions,
        sessions_with_feedback: responded.length,
        total_responses: totalResponses,
        eligible_learners: totalEligible,
        response_rate:
          totalEligible > 0
            ? Math.round((totalResponses / totalEligible) * 100)
            : null,
        avg_content: mean((s) => s.avg_content),
        avg_trainer: mean((s) => s.avg_trainer),
        avg_delivery: mean((s) => s.avg_delivery),
        min_responses_for_average: MIN_RESPONSES_FOR_AVERAGE,
      },
      sessions,
      responses: responseRows.map((r) => ({
        id: Number(r.id),
        session_id: Number(r.session_id),
        session_title: r.session_title,
        session_date: r.session_date,
        rating_content: Number(r.rating_content),
        rating_trainer: Number(r.rating_trainer),
        rating_delivery: Number(r.rating_delivery),
        comment: r.comment ?? null,
        created_at: r.created_at,
      })),
      total,
      limit,
      offset,
      has_more: offset + responseRows.length < total,
    };
  }

  /** For the `feedback_hero` badge, which counted zero until this existed. */
  async countByUser(userId: number) {
    return this.repository.countByUser(userId);
  }
}
