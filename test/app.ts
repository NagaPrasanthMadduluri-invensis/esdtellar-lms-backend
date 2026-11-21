/**
 * Boots the real AppModule in-process for the API e2e suite, configured by the
 * same `configureApp` production uses (src/app.setup.ts). Every request that
 * matches a route is recorded for the route-coverage gate.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';


import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const COVERAGE_DIR: string = require('./runtime-env').COVERAGE_DIR;

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  mkdirSync(COVERAGE_DIR, { recursive: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      const route = (req as Request & { route?: { path: string } }).route;
      if (!route) return;
      appendFileSync(join(COVERAGE_DIR, 'hits.jsonl'), JSON.stringify({ m: req.method, p: route.path, s: res.statusCode }) + '\n');
    });
    next();
  });
  configureApp(app);
  await app.init();
  return app;
}
