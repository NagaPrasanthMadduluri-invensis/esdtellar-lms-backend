import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { EmailModule } from './modules/email/email.module';
import { PgBossService } from './modules/email/queue/pg-boss.service';
import { RemindersModule } from './modules/reminders/reminders.module';

/**
 * The worker's root module.
 *
 * ## Deliberately NOT `AppModule`
 *
 * Importing AppModule would be one line and would drag in 28 feature
 * modules, every controller, and four global guards this process can never
 * reach — plus their database connections and their memory. The worker
 * needs three things: config, a database handle, and the jobs.
 *
 * ## `PgBossService` is provided HERE and nowhere else
 *
 * That is what makes it structurally impossible for the API to start a
 * second consumer. Not a convention somebody has to remember, and not a
 * runtime `if` — the provider is simply absent from the API's graph.
 *
 * The same `ConfigModule.forRoot` options as `AppModule`, including
 * `validateEnv`: a worker that boots with a missing DATABASE_URL and finds
 * out at the first query is a worker that looks healthy in pm2 while doing
 * nothing.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [configuration],
      validate: validateEnv,
      cache: true,
    }),
    DatabaseModule,
    EmailModule,
    RemindersModule,
  ],
  providers: [PgBossService],
})
export class WorkerModule {}
