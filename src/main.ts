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
import { ScormStorageService } from './modules/scorm/storage/scorm-storage.service';

async function bootstrap(): Promise<void> {
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

  app.enableCors({
    origin: config.getOrThrow<string>('clientOrigin'),
    // Required for the browser to send the HttpOnly auth cookie cross-origin.
    // A wildcard origin is not permitted alongside credentials, which is why
    // CLIENT_ORIGIN must name the exact frontend origin.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

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
   * Extracted SCORM packages, served at /scorm/<uuid>/<entry>.
   *
   * setGlobalPrefix does not apply to static assets, so this sits outside /api.
   * The client proxies this path (see client/next.config.mjs) rather than
   * pointing the player's iframe here directly: SCORM content calls
   * `window.parent.API`, and a cross-origin iframe cannot reach the parent's
   * JavaScript. Proxying keeps the content same-origin with the player while
   * the files stay owned by the server.
   */
  const scormStorage = app.get(ScormStorageService);
  if (scormStorage.driverKind === 's3') {
    /**
     * Object storage has no directory for `useStaticAssets` to mount, so the
     * bytes are streamed out of R2 by hand. Mounted at the same `/scorm`
     * prefix and right after the middleware above, so the URL the browser
     * sees is unchanged — which is the whole point: SCORM content calls
     * `window.parent.API`, and a presigned R2 URL would make the frame
     * cross-origin and break that silently (§10.1).
     */
    app.use('/scorm', app.get(ScormContentHandler).handler);
    logger.log('SCORM content served from object storage (driver=s3).');
  } else {
    app.useStaticAssets(scormStorage.rootPath, { prefix: '/scorm' });
    logger.warn(
      `SCORM content served from local disk at ${scormStorage.rootPath} ` +
        '(driver=local). This is single-instance only — a second API process ' +
        'cannot see packages this one extracted. Set SCORM_STORAGE_DRIVER=s3 ' +
        'before running more than one instance.',
    );
  }

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
