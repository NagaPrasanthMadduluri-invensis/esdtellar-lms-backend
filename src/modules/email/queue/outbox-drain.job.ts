import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EMAIL_CONSTANTS } from '@/config/configuration';

import { EmailOutboxRepository } from '../email-outbox.repository';
import { EmailRenderService } from '../email-render.service';
import { Mailer, MailSendError } from '../mailer/mailer.interface';

/**
 * Drains the outbox. The only thing in this product that sends email.
 *
 * Lives in the email module rather than the worker module so that
 * `EmailOutboxRepository` never has to be exported (§3.2) — but it is only
 * ever CALLED from the worker, by pg-boss. In the API process this class is
 * constructed and then sits there, because nothing schedules it.
 *
 * ## Backoff
 *
 * 1m, 5m, 25m, 2h, 10h, then `failed`. Five attempts is enough to ride out
 * a provider blip and few enough that a genuinely undeliverable address
 * stops costing anything within a day.
 */
const BACKOFF_SECONDS = [60, 300, 1_500, 7_200, 36_000];
const MAX_ATTEMPTS = 5;
const STUCK_AFTER_MINUTES = 10;

@Injectable()
export class OutboxDrainJob {
  private readonly logger = new Logger('EmailDrain');
  private stopping = false;

  constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly renderer: EmailRenderService,
    private readonly mailer: Mailer,
    private readonly config: ConfigService,
  ) {}

  /** Set on SIGTERM so the loop finishes the message in flight and stops. */
  beginShutdown(): void {
    this.stopping = true;
  }

  async run(): Promise<{ sent: number; failed: number; skipped: number }> {
    const result = { sent: 0, failed: 0, skipped: 0 };

    if (!this.config.get<boolean>('email.enabled')) return result;

    /**
     * The refusal that matters most, checked once per tick rather than per
     * row. A localhost CLIENT_ORIGIN under the SES driver means every link
     * in every message would be dead, and an email cannot be recalled.
     */
    const refusal = this.renderer.assertSendable(this.mailer.kind);
    if (refusal) {
      this.logger.error(`Not sending: ${refusal}`);
      return result;
    }

    const unavailable = this.mailer.unavailableReason();
    if (unavailable) {
      this.logger.error(`Not sending: ${unavailable}`);
      return result;
    }

    // Rows whose worker was hard-killed mid-send. Their `attempts` was
    // already spent at claim, so a row that keeps killing the worker
    // eventually gives up like any other failure.
    const reaped = await this.repository.reapStuck(STUCK_AFTER_MINUTES);
    if (reaped > 0) {
      this.logger.warn(`Returned ${reaped} stuck row(s) to the queue.`);
    }

    const maxPerDay = this.config.get<number>('email.maxPerDay') ?? 200;
    const sentToday = await this.repository.sentToday();
    if (sentToday >= maxPerDay) {
      this.logger.warn(
        `Daily cap reached (${sentToday}/${maxPerDay}). Holding until tomorrow.`,
      );
      return result;
    }

    const batchSize = Math.min(
      EMAIL_CONSTANTS.batchSize,
      maxPerDay - sentToday,
    );
    const rows = await this.repository.claim(batchSize);
    if (rows.length === 0) return result;

    const perSecond = Math.max(
      this.config.get<number>('email.ratePerSecond') ?? 1,
      0.1,
    );
    const gap = Math.ceil(1000 / perSecond);

    for (const row of rows) {
      if (this.stopping) {
        // Leave it claimed. The reaper returns it within ten minutes, which
        // beats racing a SIGKILL to finish the batch.
        this.logger.log('Shutting down — leaving the rest of the batch.');
        break;
      }

      /**
       * Suppression is re-checked HERE as well as at enqueue. Under sandbox
       * pacing a batch can sit for hours, and a complaint that arrives in
       * between must stop the mail that caused it.
       */
      if (await this.repository.isSuppressed(row.toEmail)) {
        await this.repository.markSuppressed(row.id, 'suppressed_before_send');
        result.skipped += 1;
        continue;
      }

      try {
        const mail = this.renderer.render(row);
        const { messageId } = await this.mailer.send(mail);
        await this.repository.markSent(row.id, messageId);
        result.sent += 1;
      } catch (error) {
        const handled = await this.handleFailure(row.id, row.attempts, error);
        result.failed += 1;
        if (handled === 'abort-batch') break;
      }

      await sleep(gap);
    }

    if (result.sent || result.failed || result.skipped) {
      this.logger.log(
        `Drain: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped.`,
      );
    }
    return result;
  }

  private async handleFailure(
    id: number,
    attempts: number,
    error: unknown,
  ): Promise<'continue' | 'abort-batch'> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof MailSendError) {
      /**
       * The account is paused. Stop the whole tick and touch nothing else:
       * continuing to push at a provider that is telling us to stop is how
       * a temporary pause becomes a closed account.
       */
      if (error.fatalForBatch) {
        await this.repository.releaseThrottled(id, 900);
        this.logger.error(`Aborting drain: ${message}`);
        return 'abort-batch';
      }

      /**
       * Throttling is NOT a message failure. The row goes back without
       * consuming an attempt — it was never wrong, we were going too fast.
       */
      if (error.throttled) {
        await this.repository.releaseThrottled(id, 60);
        return 'continue';
      }

      if (!error.retryable) {
        await this.repository.markFailed(id, message);
        return 'continue';
      }
    }

    if (attempts >= MAX_ATTEMPTS) {
      await this.repository.markFailed(
        id,
        `Giving up after ${attempts} attempts: ${message}`,
      );
      return 'continue';
    }

    const delay =
      BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    await this.repository.reschedule(id, delay, message);
    return 'continue';
  }

  /** The nightly tidy-up, scheduled beside the drain. */
  async prune(days = 90): Promise<number> {
    const removed = await this.repository.prune(days);
    if (removed > 0) this.logger.log(`Pruned ${removed} finished row(s).`);
    return removed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
