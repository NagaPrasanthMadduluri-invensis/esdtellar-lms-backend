import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { bootstrapWorker } from './worker';

async function bootstrap(): Promise<void> {
  /**
   * The same build boots two ways. `WORKER=1` starts the background worker
   * — email delivery and the scheduled jobs — and returns before any of the
   * HTTP setup below runs.
   *
   * It forks HERE, at the top, rather than threading conditionals through
   * the rest of this function: the SCORM middleware ordering below is
   * subtle enough (and commented at length enough) that adding "unless we
   * are the worker" to each step would be the change most likely to break
   * it by accident.
   */
  if (process.env.WORKER === '1') {
    await bootstrapWorker();
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = config.getOrThrow<number>('port');
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api`);
}

void bootstrap();
