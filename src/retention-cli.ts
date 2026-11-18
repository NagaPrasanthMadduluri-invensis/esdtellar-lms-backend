import 'reflect-metadata';

import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RetentionModule } from './modules/retention/retention.module';
import { RetentionService } from './modules/retention/retention.service';

/**
 * Run the retention sweep once, now, instead of waiting for 04:00 UTC.
 *
 *   npm run retention:sweep            COUNT ONLY, always, whatever .env says
 *   npm run retention:sweep -- --apply DELETE/ANONYMISE, and only when
 *                                      RETENTION_ENABLED=true AND
 *                                      RETENTION_DRY_RUN=false in .env
 *
 * The count-only default is the point: an operator can see exactly what the
 * nightly job would do in production before deciding to switch it on. --apply
 * deliberately cannot bypass the two .env switches, so the command can never
 * do more than the scheduled job would.
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
    RetentionModule,
  ],
})
class RetentionCliModule {}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  const logger = new Logger('RetentionCli');
  try {
    const config = app.get(ConfigService);
    const enabled = config.get<boolean>('retention.enabled') ?? false;
    const dryRun = config.get<boolean>('retention.dryRun') ?? true;
    if (apply && (!enabled || dryRun)) {
      logger.error(
        '--apply refused: set RETENTION_ENABLED=true and RETENTION_DRY_RUN=false in .env first. ' +
          'Run without --apply to see the counts.',
      );
      process.exitCode = 2;
      return;
    }
    const result = await app
      .get(RetentionService)
      .sweep({ enabled: true, dryRun: !apply });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void main();
