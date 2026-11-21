/**
 * Jest globalSetup for the API e2e suite: builds the world once (see world.ts).
 */
import { join } from 'node:path';

// globalSetup runs outside Jest's module mapper: register the `@/` alias
// before world.ts loads anything from src.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('tsconfig-paths').register({ baseUrl: join(__dirname, '..'), paths: { '@/*': ['src/*'] } });

export default async function globalSetup(): Promise<void> {
  const { prepareWorld } = await import('./world');
  (globalThis as Record<string, unknown>).__E2E_FAKE_AI__ = await prepareWorld();
}
