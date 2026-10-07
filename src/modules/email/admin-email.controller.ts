import {
  Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe,
  Post, Query, UnprocessableEntityException,
} from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import { EmailOutboxRepository } from './email-outbox.repository';

/**
 * What a tenant admin can see about their own organization's email.
 *
 * Until this existed the ONLY delivery read in the product was
 * `GET /platform/email/outbox`, `@PlatformAdmin()` and with no UI — so an
 * admin who imported 300 learners had no way at all to find out whether any
 * of them had been written to, and in fact none had. That is §5.2.1's
 * screen-that-lies from the other side: the machinery was real, recorded
 * everything, and was unreachable by the person who needed it.
 *
 * **What `sent` means, and the honesty this page depends on.** Under the
 * Gmail driver `sent` means Gmail ACCEPTED the message — not that it
 * arrived. The bounce and complaint feedback loop
 * (`POST /api/email/ses-events`) is SES-specific and is not wired for
 * Gmail, so nothing downstream of acceptance reaches this table. The page
 * says "handed to Gmail" in those words rather than "delivered", because a
 * delivery figure nobody is measuring is worse than an honest smaller
 * claim. Wiring Gmail's own bounce handling is the change that would let
 * this say more.
 *
 * `view_employees` rather than a new permission: every row names a person
 * in this organization and their address, so the gate that already decides
 * who may read the employee list is the right one — and adding a catalogue
 * entry costs a grant migration that signs every organization out once
 * (§10.17, §10.24).
 */
@Controller('admin/email')
@Roles('admin')
@Permissions('view_employees')
export class AdminEmailController {
  constructor(private readonly repository: EmailOutboxRepository) {}

  @Get('outbox')
  async outbox(
    @CurrentScope() scope: OrgScope,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { rows, total } = await this.repository.listForOrganization({
      organizationId: scope.organizationId,
      status: status || undefined,
      type: type || undefined,
      q: q?.trim() || undefined,
      limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
      offset: Math.max(Number(offset) || 0, 0),
    });

    const [counts, types] = await Promise.all([
      this.repository.organizationStatusCounts(scope.organizationId),
      this.repository.organizationTypes(scope.organizationId),
    ]);

    return {
      rows,
      total,
      /*
       * The tiles come from the SAME table as the rows rather than a second
       * aggregate written separately — the §10.12 instinct for the Manage
       * Users KPIs, so a tile can never disagree with the list beneath it.
       */
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      types,
    };
  }

  /**
   * Put a failed message back in the queue. 200, not 201 — nothing was
   * created; a row that already existed changed state.
   */
  @Post('outbox/:id/resend')
  @HttpCode(200)
  @Permissions('manage_users')
  async resend(
    @CurrentScope() scope: OrgScope,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const row = await this.repository.findForOrganization(scope.organizationId, id);
    /*
     * 404 for another tenant's row AND for one that does not exist — the
     * caller must not be able to tell those apart, or the id becomes a probe
     * for how much mail another organization sends.
     */
    if (!row) throw new NotFoundException('No such message');

    const requeued = await this.repository.requeue(scope.organizationId, id);
    if (!requeued) {
      /*
       * 422 and it NAMES the state, because the useful next step differs
       * per state and "could not resend" leaves the admin pressing the
       * button again. A `sent` row must not be resent (a duplicate in
       * somebody's inbox is not recoverable) and a `suppressed` one was
       * withheld deliberately — re-queuing it would walk past an
       * unsubscribe or a bounce.
       */
      throw new UnprocessableEntityException(
        row.status === 'sent'
          ? 'That message was already sent. Resending it would deliver a duplicate.'
          : row.status === 'suppressed'
            ? 'That message was withheld on purpose — the address is suppressed or the recipient opted out. Clear that first.'
            : `Only a failed message can be resent. This one is ${row.status}.`,
      );
    }

    return { ok: true, id, to_email: row.to_email };
  }
}
