/**
 * Single typed view of process.env. Nothing outside this file reads env vars
 * directly — inject ConfigService and read a namespaced key instead.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  clientOrigin: string;
  database: {
    url: string;
    authToken: string;
  };
  auth: {
    jwtSecret: string;
    /** Access-token lifetime in days. Matches the legacy 7-day token. */
    tokenDays: number;
    cookieName: string;
    cookieDomain: string;
  };
  storage: {
    driver: 'local' | 's3';
    localPath: string;
  };
}

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000',
  database: {
    url: process.env.TURSO_DB_URL ?? '',
    authToken: process.env.TURSO_AUTH_TOKEN ?? '',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET ?? '',
    tokenDays: Number(process.env.AUTH_TOKEN_DAYS ?? 7),
    cookieName: process.env.AUTH_COOKIE_NAME ?? 'lms_token',
    cookieDomain: process.env.COOKIE_DOMAIN ?? 'localhost',
  },
  storage: {
    driver: (process.env.SCORM_STORAGE_DRIVER as 'local' | 's3') ?? 'local',
    localPath: process.env.SCORM_STORAGE_PATH ?? './storage/scorm',
  },
});
