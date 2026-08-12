import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ScormStorageService } from './modules/scorm/storage/scorm-storage.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Every route is mounted under /api, matching the paths the client already
  // calls (/api/auth/login, /api/learner/courses, ...). Keeping the paths
  // identical means the migration is a base-URL change, not a rewrite.
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
   * Extracted SCORM packages, served at /scorm/<uuid>/<entry>.
   *
   * setGlobalPrefix does not apply to static assets, so this sits outside /api.
   * The client proxies this path (see client/next.config.mjs) rather than
   * pointing the player's iframe here directly: SCORM content calls
   * `window.parent.API`, and a cross-origin iframe cannot reach the parent's
   * JavaScript. Proxying keeps the content same-origin with the player while
   * the files stay owned by the server.
   */
  app.useStaticAssets(app.get(ScormStorageService).rootPath, {
    prefix: '/scorm',
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
