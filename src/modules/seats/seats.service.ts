import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { SeatsRepository } from './seats.repository';
import type { RespondToSeatsDto, SeatRequestDto, SetSeatLimitDto } from './dto/seats.dto';

@Injectable()
export class SeatsService {
  constructor(private readonly repository: SeatsRepository) {}

  /**
   * Seats used, the limit, and what is left.
   *
   * `limit: null` means unlimited — `remaining` is null too rather than
   * Infinity or a large number, so a caller cannot accidentally render
   * "∞ remaining" as a figure or compare it numerically.
   */
  async usage(scope: OrgScope) {
    const row = await this.repository.usage(scope);
    const limit = row.seat_limit === null ? null : Number(row.seat_limit);
    const used = Number(row.used);
    return {
      limit,
      used,
      remaining: limit === null ? null : Math.max(0, limit - used),
      /** At or over — the state that blocks adding a learner. */
      is_full: limit !== null && used >= limit,
      /** 80% or more. A prompt to ask before it bites, not a failure. */
      is_near_limit: limit !== null && limit > 0 && used / limit >= 0.8,
    };
  }

  /**
   * **The enforcement.** Called before a learner is created or reactivated.
   *
   * Throws 409 rather than 422: the request is well-formed, it conflicts with
   * the account's current state (§8.2). The message names the number and
   * points at the way out, because an admin who hits this needs to know what
   * to do next — not just that they cannot.
   */
  async assertSeatAvailable(scope: OrgScope): Promise<void> {
    const seats = await this.usage(scope);
    if (!seats.is_full) return;
    throw new ConflictException(
      `All ${seats.limit} seats are in use. Deactivate a learner to free one, ` +
        'or request more seats from Manage Users.',
    );
  }

  /* ── The tenant's side ───────────────────────────────────────────────── */

  async listForOrg(scope: OrgScope) {
    const [requests, seats] = await Promise.all([
      this.repository.listForOrg(scope),
      this.usage(scope),
    ]);
    return { requests, seats };
  }

  /**
   * Raise a request for more seats.
   *
   * Everything identifying comes from the verified token (§5.3), and the
   * usage figures are captured NOW rather than read back later — approving a
   * month-old request should show what the tenant saw when they asked.
   */
  async request(scope: OrgScope, actor: AuthenticatedUser, dto: SeatRequestDto) {
    const seats = await this.usage(scope);

    if (seats.limit !== null && dto.requested_seats <= seats.limit) {
      throw new UnprocessableEntityException(
        `You already have ${seats.limit} seats. Ask for more than that.`,
      );
    }
    if (dto.requested_seats < seats.used) {
      throw new UnprocessableEntityException(
        `You have ${seats.used} active learners, so the limit cannot be set below that.`,
      );
    }

    // One open request at a time — a partial unique index enforces it in
    // Postgres too, but saying so here beats a constraint-violation 500.
    const open = await this.repository.findOpenForOrg(scope);
    if (open) {
      throw new ConflictException(
        'You already have a seat request awaiting a decision.',
      );
    }

    const request = await this.repository.create({
      organizationId: scope.organizationId,
      requestedSeats: dto.requested_seats,
      currentLimit: seats.limit,
      currentUsed: seats.used,
      reason: dto.reason ?? null,
      requestedBy: actor.userId,
      contactName:
        `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email,
      contactEmail: actor.email,
    });

    return { request };
  }

  /* ── The platform's side ─────────────────────────────────────────────── */

  async listForPlatform(status?: string) {
    const requests = await this.repository.listAllForPlatform(status);
    return {
      requests,
      counts: {
        total: requests.length,
        pending: requests.filter((r) => r.status === 'pending').length,
        approved: requests.filter((r) => r.status === 'approved').length,
        declined: requests.filter((r) => r.status === 'declined').length,
      },
    };
  }

  /**
   * Approve or decline.
   *
   * **Approving WRITES the seat limit** — that is the whole point. An approval
   * that only changed a status would leave the tenant still capped while
   * being told they were not, which is the screen-that-lies failure with a
   * commercial consequence.
   *
   * `approved_seats` may differ from what was asked: the platform can grant 40
   * against a request for 50, and the tenant sees both numbers.
   */
  async respond(id: number, dto: RespondToSeatsDto) {
    const existing = await this.repository.findByIdForPlatform(id);
    if (!existing) throw new NotFoundException('Seat request not found');

    const granted =
      dto.status === 'approved'
        ? (dto.approved_seats ?? Number(existing.requested_seats))
        : null;

    if (dto.status === 'approved') {
      const used = Number(existing.current_used);
      if (granted !== null && granted < used) {
        throw new UnprocessableEntityException(
          `That tenant had ${used} active learners when they asked. ` +
            'Granting fewer seats than that would put them over the limit.',
        );
      }
      await this.repository.setSeatLimit(
        Number(existing.organization_id),
        granted,
      );
    }

    const request = await this.repository.respond(id, {
      status: dto.status,
      responseNote: dto.response_note ?? null,
      approvedSeats: granted,
    });
    return { request };
  }

  /** Set a tenant's limit directly, from the tenant directory. */
  async setLimit(organizationId: number, dto: SetSeatLimitDto) {
    const updated = await this.repository.setSeatLimit(
      organizationId,
      dto.seat_limit ?? null,
    );
    if (!updated) throw new NotFoundException('Organization not found');
    return { organization_id: updated.id, seat_limit: updated.seatLimit };
  }

  /** Seat usage for every tenant, keyed by org id. */
  async usageForAll() {
    const rows = await this.repository.usageForAll();
    return new Map(
      rows.map((r) => {
        const limit = r.seat_limit === null ? null : Number(r.seat_limit);
        const used = Number(r.used);
        return [
          Number(r.organization_id),
          {
            seat_limit: limit,
            seats_used: used,
            seats_remaining: limit === null ? null : Math.max(0, limit - used),
            seats_full: limit !== null && used >= limit,
          },
        ];
      }),
    );
  }
}
