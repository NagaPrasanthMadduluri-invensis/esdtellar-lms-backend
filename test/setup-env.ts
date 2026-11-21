// Runs before every e2e spec file: point the app at the e2e database and the
// test runtime directory (so the real server/.env is never read).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyRuntime } = require('./runtime-env');
applyRuntime();
