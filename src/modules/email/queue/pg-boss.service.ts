import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss } from 'pg-boss';

import { RemindersService } from '@/modules/reminders/reminders.service';

import { OutboxDrainJob } from './outbox-drain.job';

/**
 * pg-boss: the scheduler and the single-consumer lock.
 *
 * ## It is NOT the message store, and that is the central design decision
 *
 * The obvious shape is one pg-boss job per email. It is wrong here, for a
 * reason worth stating where somebody will read it:
 *
 *   - Publishing a job AND inserting the outbox row is a dual write. The
 *     transaction can commit on one and not the other, in either direction
 *     — a job for a notification that rolled back, or a notification whose
 *     email was silently never queued. Neither is detectable afterwards.
 *   - You lose the single-table "show me every email we ever sent this
 *     learner" query, which support needs in week one.
 *   - Per-job concurrency is a poor fit for a one-message-per-second global
 *     budget. Pacing a loop is trivially correct; pacing N independent
 *     workers is not.
 *
 * So the outbox table holds the mail and pg-boss holds the clock. What it
 * buys, and it is plenty:
 *
 *   - **Cron.** This codebase has never had a scheduler — seven places in
 *     BACKEND_STRUCTURE.md say so, and three features are missing because
 *     of it (`course_due_soon` could not fire at all).
 *   - **`singletonKey`**, so a second worker cannot drain concurrently even
 *     if pm2 is misconfigured. Belt to `FOR UPDATE SKIP LOCKED`'s braces.
 *   - Retry and backoff for the tick itself, and job history.
 *
 * ## Only the worker provides this
 *
 * It is registered by `WorkerModule` and by nothing else, so the API cannot
 * start a consumer. That is structural rather than a convention somebody
 * has to remember — the provider is simply not in the API's graph.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('PgBoss');
  private boss: PgBoss | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly drain: OutboxDrainJob,
    private readonly reminders: RemindersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.getOrThrow<string>('database.url');

    this.boss = new PgBoss({
      connectionString,
      ssl: this.config.get<boolean>('database.ssl')
        ? {
            rejectUnauthorized:
              this.config.get<boolean>('database.sslRejectUnauthorized') ?? true,
          }
        : false,
      // Its own schema, so pg-boss's tables never collide with ours and a
      // `\dt` in the app schema stays readable.
      schema: 'pgboss',
      // Small: this process runs two cron jobs, not a job farm.
      max: 2,
    });

    this.boss.on('error', (error: Error) => {
      this.logger.error(`pg-boss: ${error.message}`);
    });

    await this.boss.start();

    await this.registerDrain();
    await this.registerPrune();
    await this.registerDueSoon();

    this.logger.log(
      'Worker started — email drain every minute, due-soon reminders at ' +
        '09:00 UTC, prune at 03:00 UTC.',
    );
  }

  private async registerDrain(): Promise<void> {
    const boss = this.boss!;
    const queue = 'email-outbox-drain';
    await boss.createQueue(queue);

    await boss.work(queue, async () => {
      await this.drain.run();
    });

    /**
     * `singletonSeconds` just under the interval, so a tick that overruns
     * cannot stack a second one behind it. A drain that is still sending
     * when the next minute arrives should be left alone, not doubled.
     */
    await boss.schedule(queue, '* * * * *', undefined, {
      singletonKey: 'drain',
      singletonSeconds: 55,
    });
  }

  private async registerPrune(): Promise<void> {
    const boss = this.boss!;
    const queue = 'email-outbox-prune';
    await boss.createQueue(queue);
    await boss.work(queue, async () => {
      await this.drain.prune(90);
    });
    // 03:00 UTC — nothing else runs then, and the delete is a long scan.
    await boss.schedule(queue, '0 3 * * *', undefined, {
      singletonKey: 'prune',
    });
  }

  /**
   * `course_due_soon`, the first scheduled job this product has ever had.
   *
   * 09:00 UTC — a reminder that lands overnight is read with the morning's
   * backlog, and the alternative (the learner's own local morning) would
   * need a per-tenant timezone this product does not store.
   */
  private async registerDueSoon(): Promise<void> {
    const boss = this.boss!;
    const queue = 'course-due-soon';
    await boss.createQueue(queue);
    await boss.work(queue, async () => {
      await this.reminders.sendDueSoon();
    });
    await boss.schedule(queue, '0 9 * * *', undefined, {
      singletonKey: 'due-soon',
    });
  }

  /**
   * Graceful stop.
   *
   * `beginShutdown()` first, so the drain loop finishes the message it is
   * sending and then stops claiming new ones — the rest of the batch stays
   * claimed and the reaper returns it within ten minutes. Racing a SIGKILL
   * to finish 25 sends would be the worse trade.
   */
  async onApplicationShutdown(): Promise<void> {
    this.drain.beginShutdown();
    if (!this.boss) return;
    try {
      await this.boss.stop({ graceful: true, close: true });
      this.logger.log('pg-boss stopped.');
    } catch (error) {
      this.logger.warn(
        `pg-boss did not stop cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
