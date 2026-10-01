export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  /**
   * The CANONICAL public UI origin — the first entry of `CLIENT_ORIGIN`.
   *
   * This is what every absolute URL the server builds is built from: the
   * links in emails, above all, which cannot be recalled once sent. When
   * several origins are allowed it must be the one you want people to end
   * up on, not merely one that works.
   */
  clientOrigin: string;
  /**
   * EVERY origin CORS will accept, in order.
   *
   * `CLIENT_ORIGIN` takes a comma-separated list so a domain rename does
   * not have to be a hard cutover. During one, the old host still resolves
   * and people still have it bookmarked — and with a single allowed origin
   * every request from it fails CORS, including the login POST, so the app
   * is not "degraded" there, it is completely dead with no error a user can
   * act on.
   *
   * Exact strings only, never a wildcard or a suffix match: `credentials:
   * true` makes a wildcard illegal, and a suffix match would accept
   * `evil-edstellar.com`.
   */
  clientOrigins: string[];
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
    /**
     * Root for files this process writes and serves itself, rather than
     * handing to R2 — currently course thumbnails. Local disk, like the
     * `local` SCORM driver above and with the same single-instance caveat.
     */
    uploadsPath: string;
  };
  reporting: {
    /**
     * Pins "today" for every report. Leave unset in production so monthly
     * figures track the real calendar; set it to a date inside the seeded
     * period to demo seed data.
     */
    referenceDate: string | null;
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
    /** Cap for an uploaded document — a slide deck, not a feature film. */
    documentMaxBytes: number;
  };
  /**
   * Transactional email.
   *
   * EVERY DEFAULT HERE IS THE SAFE ONE, which is the point: `enabled` is
   * false, the driver writes to a log rather than the internet, and the
   * rate limits are the SES *sandbox* figures. A deployment that forgets
   * these variables sends nothing; a deployment that sets half of them
   * sends slowly. Neither mails 500 learners by accident.
   *
   * Nothing here is added to `env.validation.ts`. Email degrades the way
   * R2 does (see `media/storage/r2-storage.service.ts`) — a warn at boot
   * naming what is missing, and a service that refuses to send. Making it
   * a boot requirement would make email a hard dependency of every
   * endpoint in the API.
   */
  email: {
    /** The off switch, and step one of any rollout. */
    enabled: boolean;
    /** `log` prints, `file` writes .eml to disk, `ses` actually sends. */
    driver: 'log' | 'file' | 'ses';
    /** Must be an SES-verified identity, so it differs per environment. */
    from: string;
    /**
     * Sends per second, and the hard stop per UTC day.
     *
     * Env vars rather than constants for one reason: they change when SES
     * grants production access (1/sec -> 14/sec, 200/day -> 50,000/day),
     * and being able to slow sending down during a problem without
     * stopping it entirely is worth not needing a deploy for.
     */
    ratePerSecond: number;
    maxPerDay: number;
    /**
     * When non-empty, any recipient NOT matching is written `suppressed`
     * instead of sent. An address or a `@domain` suffix, comma-separated.
     * This is what makes a production dry-run possible, and it is widened
     * over days — so it has to be changeable without a deploy.
     */
    allowlist: string[];
    ses: {
      region: string;
      /** Enables SES-side bounce and complaint suppression. */
      configurationSet: string;
    };
  };
}

/**
 * Email settings that are NOT environment variables, and the reason.
 *
 * These were env vars in the first cut of 0037 and it was too many knobs.
 * The test each one failed: would this ever legitimately differ between
 * this machine and production, or change without a code change? For all
 * five the answer is no — they are product decisions or internal tuning,
 * and a variable nobody ever sets is just more surface to get wrong.
 *
 * `EMAIL_FROM_NAME` in particular was a mistake worth naming: §10.2.1 says
 * the product name lives in ONE constant, and making it configurable here
 * created a second place a rename could be missed.
 */
export const EMAIL_CONSTANTS = {
  /** Where the `file` driver writes. Dev-only; gitignored. */
  outboxPath: './storage/outbox',
  /** How long a password-reset link is good for. A product decision. */
  passwordResetTtlMinutes: 60,
  /** Rows claimed per drain tick. Internal tuning. */
  batchSize: 25,
  /**
   * Above this a fan-out is SKIPPED entirely rather than truncated, and
   * logged at error. Telling some learners and not others, with no way to
   * know which, is the worse failure.
   */
  maxRecipientsPerNotify: 200,
} as const;

/**
 * Splits `CLIENT_ORIGIN` into the list CORS accepts.
 *
 * A single value behaves exactly as it always did, so nothing has to change
 * in a deployment that is not mid-rename. Trailing slashes are stripped
 * because an `Origin` header never carries one, and a configured
 * `https://app.example.com/` would silently match nothing.
 */
function clientOrigins(): string[] {
  const configured = (process.env.CLIENT_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return configured.length > 0 ? configured : ['http://localhost:3000'];
}

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: clientOrigins()[0],
  clientOrigins: clientOrigins(),
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
    uploadsPath: process.env.UPLOAD_STORAGE_PATH ?? './storage/uploads',
  },
  reporting: {
    referenceDate: process.env.REPORTING_REFERENCE_DATE || null,
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
    documentMaxBytes: Number(
      process.env.DOCUMENT_MAX_BYTES ?? 100 * 1024 * 1024,
    ),
  },
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    // Defaults to `log` rather than `ses`: a deployment that enables email
    // and forgets the driver writes to a log, which is recoverable. The
    // opposite mistake is not.
    driver: (process.env.EMAIL_DRIVER as 'log' | 'file' | 'ses') ?? 'log',
    from: process.env.EMAIL_FROM ?? '',
    // The defaults are the SES SANDBOX figures, so a half-configured
    // production sends slowly rather than catastrophically.
    ratePerSecond: Number(process.env.EMAIL_RATE_PER_SECOND ?? 1),
    maxPerDay: Number(process.env.EMAIL_MAX_PER_DAY ?? 200),
    allowlist: (process.env.EMAIL_ALLOWLIST ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    ses: {
      region: process.env.SES_REGION ?? 'ap-south-1',
      configurationSet: process.env.SES_CONFIGURATION_SET ?? '',
      // No credential keys here. The AWS SDK's own provider chain already
      // reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, then the shared
      // config, then the EC2 instance role. Bespoke SES_* names added
      // nothing and invited somebody to put a key on disk that the
      // instance role made unnecessary.
    },
  },
});
