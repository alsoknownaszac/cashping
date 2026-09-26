/**
 * Environment variable loading/typing.
 *
 * Wired into `ConfigModule.forRoot({ load: [configuration] })` (Step 4).
 *
 * Values are read from `process.env`, which `ConfigModule` has already validated
 * and normalised against `src/config/validation.schema.ts` before this factory
 * runs. That is why required values can be asserted as present and `PORT` is
 * already coerced from its string form to a number.
 */
/**
 * Browser origins allowed to call the API when `CORS_ALLOWED_ORIGINS` is unset:
 * the ports a local frontend dev server most often listens on (Next.js/CRA on
 * 3000, Vite on 5173).
 *
 * The default lives here, next to the variable it backs, rather than in the
 * validation schema - so it has exactly one definition and the schema's only job
 * is to say what a *supplied* value must look like.
 */
export const DEFAULT_CORS_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
] as const;

/**
 * Whether the Swagger UI and the OpenAPI document are served when
 * `ENABLE_SWAGGER` is unset.
 *
 * On by default: locally the docs *are* how the frontend engineer works against
 * the API, and the e2e suite asserts they are served. Production is expected to
 * set `ENABLE_SWAGGER=false`, which `docker-compose.yml` mirrors (the compose
 * service runs with `NODE_ENV=production`).
 */
export const DEFAULT_SWAGGER_ENABLED = true;

/**
 * Region assumed for phone numbers submitted in national format (`024 123 4567`)
 * when `PHONE_DEFAULT_REGION` is unset.
 *
 * Ghana because that is the market the registration flow is specified against -
 * `024...`, `+233024...` and `233024...` are all the same Ghanaian number in the
 * build sequence's own examples. It is a *default*, not a hard-coded assumption:
 * normalization is the one place where a wrong region silently turns into a
 * wrong number, and the ledger account is denominated in NGN while these
 * examples are Ghanaian, so the value is overridable rather than baked in.
 *
 * Numbers that arrive in international form (`+2348031234567`) ignore it
 * entirely - the region only tells the parser how to read a local spelling.
 */
export const DEFAULT_PHONE_REGION = 'GH';

/**
 * OTP policy (Steps 12-13), in one place because three consumers have to agree:
 * `OtpService` (how long a code lives, how many tries it survives),
 * `OtpRateLimiterService` (how many codes one number may request) and
 * `NotificationsService` (what the SMS text *says* the user has). The last one is
 * the reason these are not private to the OTP service: a message that promises
 * ten minutes while the row expires in five is a support ticket about a bug that
 * does not exist.
 */
/** Digits in a code. 6 keeps it typeable from a lock screen. */
export const OTP_CODE_LENGTH = 6;
/** How long a code stays valid. */
export const OTP_TTL_MINUTES = 10;
/**
 * Wrong codes a single code tolerates before it is dead. Bounded attempts are
 * what make a 6-digit code worth having: without them a code is a million-guess
 * problem with no cost per guess.
 */
export const OTP_MAX_ATTEMPTS = 5;
/**
 * Codes one phone number may request inside a window. This is the SMS-pumping
 * control (Step 13) as much as a rate limit: each request costs real money at
 * Africa's Talking, so the limit is on *sends*, and it is per number rather than
 * per caller, because the number is what is being pumped.
 */
export const OTP_REQUESTS_PER_WINDOW = 3;
export const OTP_REQUEST_WINDOW_MINUTES = 15;

/**
 * Africa's Talking API hosts.
 *
 * Two hosts, one API: the sandbox app is served by `api.sandbox...` and a live
 * username by `api...`. Verified against the sandbox credentials on 2026-09-26 -
 * the sandbox key authenticates on the sandbox host (HTTP 200) and is rejected
 * with a 401 on the live host, so picking the wrong one is a hard failure at the
 * first registration, not a silent one.
 */
export const AFRICASTALKING_SANDBOX_BASE_URL = 'https://api.sandbox.africastalking.com';
export const AFRICASTALKING_LIVE_BASE_URL = 'https://api.africastalking.com';

/**
 * Resolves the Africa's Talking host the SMS client should call.
 *
 * The username decides, because that is exactly what it means to Africa's
 * Talking: `sandbox` is the shared sandbox app, anything else is a live account.
 * `AFRICASTALKING_BASE_URL` overrides the lot, for pointing at a stub server in a
 * test without inventing a username that does not exist.
 *
 * A trailing slash is stripped rather than rejected: every caller appends
 * `/version1/...`, so a normalised value cannot produce a double slash, and there
 * is no way for this to be wrong silently - unlike the CORS allow-list, where a
 * value a browser never sends has to fail at boot.
 */
export function resolveAfricasTalkingBaseUrl(
  username: string,
  override: string | undefined,
): string {
  const explicit = override?.trim();
  const resolved =
    explicit !== undefined && explicit !== ''
      ? explicit
      : username === 'sandbox'
        ? AFRICASTALKING_SANDBOX_BASE_URL
        : AFRICASTALKING_LIVE_BASE_URL;

  return resolved.replace(/\/+$/, '');
}

/**
 * Reads a boolean flag from `process.env`.
 *
 * `process.env` only ever holds strings and `Boolean('false')` is `true`, so the
 * parsing has to be explicit. Only the literals `true`/`false` (any case, outer
 * whitespace ignored) are recognised; anything else falls back here *and* is
 * rejected with the variable's name by `validation.schema.ts` before the app
 * listens - so a typo is a boot-time error, not a silently-wrong docs setting.
 *
 * `main.ts` calls this factory directly, before `ConfigModule` has validated
 * anything, which is the other reason it cannot assume a coerced value.
 */
function readBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  switch (raw?.trim().toLowerCase()) {
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      return fallback;
  }
}

export default function configuration() {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),

    /**
     * Origins allowed to call the API from a browser, as a ready-to-use array.
     *
     * Never a wildcard: the frontend is served from a known origin, and `*` would
     * let any page a signed-in user visits call the API with their token.
     * `validation.schema.ts` rejects values a browser never sends in `Origin` (a
     * trailing slash, a missing scheme, `*`), because those otherwise fail as an
     * opaque CORS error at request time instead of at boot.
     */
    cors: {
      allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? DEFAULT_CORS_ALLOWED_ORIGINS.join(','))
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    },

    /**
     * Interactive docs (Swagger UI at `/api/docs`, OpenAPI document at
     * `/api/docs-json`).
     *
     * On unless switched off. Production sets `ENABLE_SWAGGER=false`: the API
     * surface is not a secret from the team, but every endpoint plus a live "Try
     * it out" console is an invitation nobody needs on a public host.
     */
    swagger: {
      enabled: readBooleanFlag(process.env.ENABLE_SWAGGER, DEFAULT_SWAGGER_ENABLED),
    },

    /** PostgreSQL connection string consumed by Prisma. */
    database: {
      url: process.env.DATABASE_URL as string,
    },

    /** Redis connection string (BullMQ queues, rate limiting, idempotency keys). */
    redis: {
      url: process.env.REDIS_URL as string,
    },

    /** JWT signing configuration. */
    auth: {
      jwtSecret: process.env.JWT_SECRET as string,
    },

    /**
     * Phone number handling (Step 9).
     *
     * `defaultRegion` is what a national-format input (`024 123 4567`) is read
     * against; an international input (`+2348031234567`) carries its own region
     * and this value is not consulted. Uppercased here so the normalizer receives
     * exactly the ISO 3166-1 alpha-2 code libphonenumber expects, whatever case
     * the variable was written in - `validation.schema.ts` has already rejected a
     * code the metadata does not contain.
     */
    phone: {
      defaultRegion: (process.env.PHONE_DEFAULT_REGION ?? DEFAULT_PHONE_REGION)
        .trim()
        .toUpperCase(),
    },

    /**
     * OTP policy (Steps 12-13). Constants rather than environment variables:
     * these are the product's rules (a 6-digit code, 3 sends per 15 minutes), not
     * per-environment settings, and every one of them is asserted by a test - so
     * they belong in the code, where a change shows up in review.
     */
    otp: {
      codeLength: OTP_CODE_LENGTH,
      ttlMinutes: OTP_TTL_MINUTES,
      maxAttempts: OTP_MAX_ATTEMPTS,
      requestsPerWindow: OTP_REQUESTS_PER_WINDOW,
      requestWindowMinutes: OTP_REQUEST_WINDOW_MINUTES,
    },

    /** Outbound SMS via Africa's Talking. */
    notifications: {
      africasTalking: {
        apiKey: process.env.AFRICASTALKING_API_KEY as string,
        username: process.env.AFRICASTALKING_USERNAME ?? 'sandbox',
        /**
         * Resolved, not raw: the sandbox and live accounts live on different
         * hosts, so the username picks the host and `AFRICASTALKING_BASE_URL` can
         * override it (a stub server in a test). See
         * `resolveAfricasTalkingBaseUrl`.
         */
        baseUrl: resolveAfricasTalkingBaseUrl(
          process.env.AFRICASTALKING_USERNAME ?? 'sandbox',
          process.env.AFRICASTALKING_BASE_URL,
        ),
      },
    },

    /** Error reporting. */
    sentry: {
      dsn: process.env.SENTRY_DSN as string,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    },

    /** AWS credentials + KMS key used to wrap Stellar secret seeds. */
    aws: {
      region: process.env.AWS_REGION as string,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      kmsKeyId: process.env.AWS_KMS_KEY_ID as string,
    },

    /** Stellar network selection. */
    stellar: {
      network: process.env.STELLAR_NETWORK as string,
      horizonUrl: process.env.STELLAR_HORIZON_URL as string,
    },
  };
}

/**
 * The shape this factory returns - what `ConfigModule` exposes and what
 * `main.ts` works with at boot, derived from the factory itself so the two cannot
 * drift.
 */
export type AppConfig = ReturnType<typeof configuration>;
