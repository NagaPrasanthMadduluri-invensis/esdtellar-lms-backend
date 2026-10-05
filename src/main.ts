import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { setReferenceDate } from './modules/learning-hours/periods';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ScormContentHandler } from './modules/scorm/scorm-content.handler';
import { ScormContentMiddleware } from './modules/scorm/scorm-content.middleware';
import { ImageStorageService } from './modules/media/storage/image-storage.service';
import { ScormStorageService } from './modules/scorm/storage/scorm-storage.service';
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
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Every route is mounted under /api, matching the paths the client already
  // calls (/api/auth/login, /api/learner/courses, ...). Keeping the paths
  // identical means the migration is a base-URL change, not a rewrite.
  // Reports normally track the real calendar. REPORTING_REFERENCE_DATE pins
  // them to a chosen day so the seeded period can still be demonstrated.
  const referenceDate = config.get<string | null>('reporting.referenceDate');
  setReferenceDate(referenceDate ?? null);
  if (referenceDate) {
    logger.warn(
      `Reporting period pinned to ${referenceDate}. Monthly figures will not ` +
        'track the real calendar until REPORTING_REFERENCE_DATE is removed.',
    );
  }

  app.setGlobalPrefix('api');

  app.use(cookieParser());

  /**
   * CORS. `CLIENT_ORIGIN` may name SEVERAL origins, comma-separated, which
   * exists for domain renames: during one the old host still resolves and
   * is still bookmarked, and a single allowed origin means every request
   * from it fails CORS — including the login POST, so the old URL is not
   * degraded, it is dead with no error a user can act on.
   *
   * Exact strings, never a wildcard or a suffix: `credentials: true` makes
   * a wildcard illegal (it is what lets the browser attach the HttpOnly
   * auth cookie at all), and a suffix match would accept
   * `evil-edstellar.com`.
   */
  const allowedOrigins = config.getOrThrow<string[]>('clientOrigins');
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  logger.log(
    `CORS allows ${allowedOrigins.join(', ')}. Links in email are built ` +
      `from ${config.getOrThrow<string>('clientOrigin')}.`,
  );

  /**
   * Authenticates every request under /scorm BEFORE useStaticAssets ever
   * touches disk (multi-tenancy.md §3.9 / §7.4). `useStaticAssets` mounts
   * outside the Nest guard chain — AuthGuard never sees these requests — so
   * without this, any anonymous caller holding a package UUID could read the
   * files directly.
   *
   * Registered with plain `app.use`, NOT a `MiddlewareConsumer`: consumer
   * middleware is only applied during `app.init()`, which `app.listen()`
   * runs internally — i.e. AFTER `useStaticAssets` below is already mounted.
   * It would silently never run. This must stay:
   *   - after cookieParser() above, or req.cookies is undefined;
   *   - before useStaticAssets below, since Express dispatches middleware in
   *     registration order and express.static terminates the request.
   */
  app.use('/scorm', app.get(ScormContentMiddleware).handler);

  /**
   * Extracted SCORM packages, served at /scorm/<uuid>/<entry> — streamed out
   * of R2, never from disk.
   *
   * setGlobalPrefix does not apply here, so this sits outside /api. The
   * client proxies the path (`client/next.config.mjs`) rather than pointing
   * the player's iframe at object storage directly, and that indirection is
   * not optional: SCORM content calls `window.parent.API.LMSSetValue(...)`,
   * and a frame served from `*.r2.cloudflarestorage.com` is cross-origin to
   * the player page, so every one of those calls throws on property access
   * and the package records nothing — silently. It does not error; it just
   * never tracks.
   *
   * So the bytes live in Cloudflare and the URL stays same-origin.
   *
   * There is no `useStaticAssets` branch any more. The local-disk driver was
   * removed once every package lived in R2 (§10.31): it pinned the API to one
   * instance, because a second process could not see what the first had
   * extracted.
   */
  app.use('/scorm', app.get(ScormContentHandler).handler);
  const scormStorage = app.get(ScormStorageService);
  if (scormStorage.isReady) {
    logger.log('SCORM content streamed from object storage (R2).');
  } else {
    // Not a fallback, because there is nothing to fall back to. Said loudly
    // because SCORM is entirely unavailable in this state, not degraded.
    logger.error(
      'SCORM storage is NOT configured — missing ' +
        `${scormStorage.missingConfig.join(', ')}. Upload and playback will ` +
        'return 503 until these are set and the process is RESTARTED.',
    );
  }

  /**
   * Course thumbnails, served at /uploads/course-thumbnails/<uuid>.<ext>.
   *
   * Deliberately NOT behind the auth middleware `/scorm` gets, and the reason
   * is `next/image`: the optimizer fetches the source server-side, with no
   * user cookie, so an authenticated thumbnail would render as a broken image
   * for everyone. What is exposed is a course's cover picture addressed by a
   * random UUID — not learner data, not course content — and the filename is
   * never derived from anything guessable.
   *
   * `immutable` is safe because a replacement is written under a NEW uuid and
   * the old file is deleted, so a cached URL can never show the wrong picture.
   */
  const imageStorage = app.get(ImageStorageService);
  app.useStaticAssets(imageStorage.rootPath, {
    prefix: '/uploads',
    maxAge: '365d',
    immutable: true,
    index: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown keys so a client cannot smuggle extra fields into a DTO.
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  const port = config.getOrThrow<number>('port');
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api`);
}

void bootstrap();
