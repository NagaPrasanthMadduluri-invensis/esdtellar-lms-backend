export default async function globalTeardown(): Promise<void> {
  const server = (globalThis as Record<string, unknown>).__E2E_FAKE_AI__ as { close: () => void } | undefined;
  server?.close();
}
