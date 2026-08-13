/**
 * Fail fast at boot rather than at the first request. The legacy code fell back
 * to a hardcoded JWT secret ("edstellar-lms-demo-2026") when JWT_SECRET was
 * unset, which silently produced forgeable tokens in any environment that
 * forgot the variable. There is no fallback here by design.
 */
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'] as const;

export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set them in server/.env before starting the API.`,
    );
  }

  const secret = String(config.JWT_SECRET);
  if (secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be at least 32 characters. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }

  return config;
}
