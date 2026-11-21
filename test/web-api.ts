/**
 * The API the Playwright journeys (client/e2e) talk to: prepares the e2e world
 * (database, fixtures, fake AI) and then serves the REAL app exactly as
 * main.ts does, on E2E_API_PORT (3201). Run with:
 *   node -r ts-node/register/transpile-only -r tsconfig-paths/register test/web-api.ts
 * (npm run e2e:web-api). Never touches the dev database or the dev servers.
 */
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { prepareWorld } from './world';

async function main(): Promise<void> {
  await prepareWorld();
  const { AppModule } = await import('@/app.module');
  const { configureApp } = await import('@/app.setup');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  configureApp(app);
  const port = Number(process.env.PORT);
  await app.listen(port);
  console.log(`e2e API listening on http://localhost:${port}/api`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
