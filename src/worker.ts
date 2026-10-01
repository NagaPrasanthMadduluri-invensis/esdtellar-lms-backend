import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { setReferenceDate } from './modules/learning-hours/periods';
import { WorkerModule } from './worker.module';

/**
 * The background worker: email delivery and the scheduled jobs.
 *
 * Same build as the API, started with `WORKER=1`, supervised by pm2 as a
 * second process.
 *
 * ## `createApplicationContext`, not `create`
 *
 * This is the real answer to "no HTTP listener". It is not that we decline
 * to call `listen()` — it is that **no Express instance is ever created**.
 * No port to collide with the API's, no global pipes, no CORS, no guards,
 * no static mounts, and nothing that could accidentally serve a request.
 *
 * ## Why a separate process at all
 *
 * The API is a single pm2 fork — one Node process, one thread for all
 * JavaScript. Draining the outbox there would put SMTP round trips in the
 * same queue as page requests. SMTP is network-wait so it yields and the
 * API would stay usable, but there is a second reason that does not: this
 * process is also where the cron lives, and a scheduled job inside a web
 * server is a job that runs N times when you scale to N instances.
 */
async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('Worker');

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    // The API logs these at boot already; the worker repeating them doubles
    // every startup line in pm2's log.
    bufferLogs: false,
  });

  /**
   * The reporting reference date is process-global state, set from config
   * in `main.ts`. The worker has to set it too — `RemindersService` asks
   * "what is due soon", and if the API is pinned to a seeded month while
   * the worker reads the real calendar, the two disagree about what day it
   * is and the reminders describe a different world from the screens.
   */
  const referenceDate = app
    .get(ConfigService)
    .get<string | null>('reporting.referenceDate');
  setReferenceDate(referenceDate ?? null);
  if (referenceDate) {
    logger.warn(`Reporting period pinned to ${referenceDate}.`);
  }

  // So SIGTERM reaches OnApplicationShutdown and pg-boss can stop cleanly,
  // rather than the in-flight send being killed mid-socket.
  app.enableShutdownHooks();

  logger.log('Worker context ready.');
}

export { bootstrapWorker };
