export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  clientOrigin: string;
  database: {
    url: string;
    ssl: boolean;
    sslRejectUnauthorized: boolean;
  };
  auth: {
    jwtSecret: string;
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
    url: process.env.DATABASE_URL ?? '',
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
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
