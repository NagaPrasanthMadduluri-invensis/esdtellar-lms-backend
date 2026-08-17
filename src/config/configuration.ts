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
  media: {
    /** Cloudflare R2, addressed through its S3-compatible API. */
    r2: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      endpoint: string;
    };
    /** Lifetime of a presigned playback URL. */
    videoUrlTtlSeconds: number;
    /** Lifetime of a presigned upload URL — the admin has this long to start. */
    uploadUrlTtlSeconds: number;
    videoMaxBytes: number;
    captionMaxBytes: number;
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
  media: {
    r2: {
      accountId: process.env.R2_ACCOUNT_ID ?? '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
      bucket: process.env.R2_BUCKET ?? '',
      // R2_ENDPOINT is the account-level S3 endpoint, WITHOUT the bucket path —
      // the SDK appends the bucket itself. S3_API_ENDPOINT in the Cloudflare
      // dashboard includes the bucket and would produce `/bucket/bucket/key`,
      // so it is deliberately not read here.
      endpoint:
        process.env.R2_ENDPOINT ??
        (process.env.R2_ACCOUNT_ID
          ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
          : ''),
    },
    videoUrlTtlSeconds: Number(process.env.VIDEO_URL_TTL_SECONDS ?? 900),
    uploadUrlTtlSeconds: Number(process.env.UPLOAD_URL_TTL_SECONDS ?? 3600),
    videoMaxBytes: Number(process.env.VIDEO_MAX_BYTES ?? 2 * 1024 * 1024 * 1024),
    captionMaxBytes: Number(process.env.CAPTION_MAX_BYTES ?? 2 * 1024 * 1024),
  },
});
