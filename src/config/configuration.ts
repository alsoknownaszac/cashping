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
 * Largest JSON request body the API will parse, when `BODY_LIMIT_JSON` is unset.
 *
 * Implicit before this (Step 34 follow-up): with no `limit`, Express's `json()` default of `100kb`
 * applied silently - looser than this API needs, and invisible, since nothing in the code said what
 * the ceiling was or why. `16kb` is the explicit answer, derived from the bodies the API actually
 * accepts rather than picked round: the largest legitimate request across every endpoint is
 * `POST /v1/auth/login/password` at ~408 bytes (a 254-character email plus a 128-character
 * password), so 16 KiB is ~40x the biggest real body while still being 6.25x smaller than the
 * `100kb` default it replaces. That leaves room for a client to pretty-print, to add fields, or to
 * grow an email address without leaving room for the request to be a payload.
 *
 * The unit-suffixed string form (`16kb`) is what `body-parser`'s own `limit` option takes, so it is
 * stored verbatim rather than converted to a byte count here - one fewer place for two numbers that
 * are meant to be the same to drift apart.
 */
export const DEFAULT_JSON_BODY_LIMIT = '16kb';

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
 * Transaction PIN policy (Step 34a).
 *
 * Constants rather than environment variables, for the reason the OTP block above gives:
 * these are the product's rules - four digits, five guesses, a quarter-hour lock - not
 * per-environment settings, and every one of them is asserted by a test.
 *
 * They are gathered here, beside the OTP's, because the service and the message have to
 * agree about them for the same reason the SMS text has to agree with the OTP's TTL: a
 * response that says "3 attempts remaining" while the service allows five is a support
 * ticket about a bug that does not exist.
 */
/**
 * Digits in a PIN. Four, and exactly four.
 *
 * Typed from memory at a payment screen rather than copied from an SMS, so the digit
 * count is a usability ceiling; the security comes from the allowance below, not from
 * the length. See `pin-pattern.ts` for the one place the rule is turned into a
 * validation pattern.
 */
export const PIN_LENGTH = 4;
/**
 * Wrong PINs one account tolerates before the PIN is locked.
 *
 * Five, matching the OTP's allowance, and chosen against the ten thousand possible
 * PINs rather than against a person's patience: at five guesses per window, an
 * exhaustive search is two thousand windows long, which is what makes guessing a birth
 * year or a repeated digit not worth the wait.
 */
export const PIN_MAX_ATTEMPTS = 5;
/**
 * How long a locked PIN stays locked, in minutes.
 *
 * Fifteen, matching the OTP request window: long enough that a scripted sweep of the
 * key space makes no progress, short enough that someone who mistyped three times and
 * then remembered their PIN is not sent to support.
 */
export const PIN_LOCKOUT_MINUTES = 15;
/**
 * How long a step-up token is accepted after a PIN has been proved.
 *
 * Five minutes, chosen against the *gap* it has to cover: the user proves the PIN, is
 * returned to the payment screen and confirms. Long enough that a slow form does not
 * fail, short enough that a token captured from a log or a proxy is stale before it is
 * useful - which is what makes "fresh" a property of the token rather than a claim about
 * the client's behaviour.
 */
export const STEP_UP_TOKEN_TTL_MINUTES = 5;

/**
 * Password policy (Step 34b).
 *
 * Constants rather than environment variables, like the OTP and PIN blocks above and for
 * the same reason: how long a password has to be is the product's rule, not a
 * per-environment setting, and every one of them is asserted by a test.
 *
 * `PASSWORD_MIN_LENGTH` is eight - longer than a PIN and shorter than a passphrase, chosen
 * because the password is the *recovery* credential as much as the everyday one: it is
 * drawn from a human's memory, and the value of a minimum is that it stops `1234` from
 * being a password rather than that it makes one strong. A password is a dictionary attack
 * rather than a sweep, which is why `secret-hash.ts` hashes one with a stronger work factor
 * than the PIN's.
 *
 * `PASSWORD_MAX_LENGTH` is a ceiling rather than a security rule: scrypt's cost grows with
 * the input, so an unbounded body would let one request spend a worker's time deriving a
 * megabyte-long key. The bound is generous enough that no passphrase a person types is
 * refused.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The address a verification or receipt email is sent from (Step 34c).
 *
 * A constant with an environment override rather than a required variable: the *seam* is
 * `EMAIL_SENDER` (see `NotificationsModule`), and the from-address is part of the wording
 * that lives beside the sender rather than a provider credential. `EMAIL_FROM` overrides
 * it for a deployment whose provider requires a verified sender domain.
 *
 * The default is Resend's shared test address rather than a `@cashping.app` one, because that
 * domain is not verified in Resend yet and Resend refuses an unverified sender. It only delivers
 * to the address the Resend account itself is registered under, so this is a development default
 * rather than a shipping one: set `EMAIL_FROM` to a verified `@cashping.app` address once the
 * domain is set up in the Resend dashboard.
 */
export const DEFAULT_EMAIL_FROM = 'Cashping <onboarding@resend.dev>';

/**
 * Recipient directory policy (Step 21).
 *
 * Constants rather than environment variables, like the OTP block above and for the same
 * reason: these are product rules (how many lookups one account gets in a minute), not
 * per-environment settings, and they belong where a change shows up in review.
 *
 * Why a limit is needed at all: `GET /v1/recipients/search` answers "is this number
 * registered", so an unlimited caller can sweep numbers and read the answer off the
 * difference between a result and an empty list. The numbers below are chosen against that
 * sweep rather than against a person's use: 20 lookups a minute is far more than anyone
 * needs to find the person they are about to pay (one search plus one confirmation is two),
 * and it caps a sweep at 28,800 numbers a day per account - slow enough that the *pattern* is
 * visible in `recipients:lookup:*` long before the sweep is useful. The limiter is per caller
 * and shared by both directory endpoints, so the pair of calls one payment costs is priced at
 * two units.
 */
export const RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW = 20;
export const RECIPIENT_LOOKUP_WINDOW_SECONDS = 60;

/**
 * Idempotency policy (Step 24).
 *
 * A constant rather than an environment variable, like the block above and for the same reason:
 * how long a key remembers a payment is a product rule, and it belongs where a change to it
 * shows up in review rather than in a `.env` nobody diffs.
 *
 * A day is chosen against what the number is *for*. The claim is what answers a retry with the
 * original response, so it has to outlive every realistic retry: a client that lost its response
 * retries in seconds, a client whose process crashed on a bad network retries when the user
 * reopens the app, and the same user sending the same payment again *tomorrow* is not a retry -
 * it is a new payment, and it should get a fresh key from the client (which is why the client
 * generates one per payment attempt and not per screen). Making this shorter trades a rare
 * duplicate risk for a rare missing-replay, and the price of the second is worse: without a
 * stored response the duplicate is a 409, which the client cannot distinguish from "your payment
 * failed" without a history endpoint.
 *
 * The TTL is also the *claim's* lifetime, not just the result's: a request that dies mid-flight
 * stops blocking its key after this long, and the transaction table's unique index is what keeps
 * that from becoming a second payment. See `RedisIdempotencyStore`.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Session policy (Step 16).
 *
 * The two lifetimes are a deliberate pair, and the split is what makes the JWT
 * design work at all. An access token cannot be withdrawn: the API verifies its
 * signature and never asks the database, so its 15 minutes *are* the mitigation for
 * a leaked token. A refresh token can be withdrawn, because it is looked up in
 * `refresh_tokens` on every use - so it is the one that gets to live for 30 days.
 *
 * 15 minutes is short enough to matter and long enough not to be a nuisance: a
 * client that refreshes on 401 loses no more than a second per quarter hour, while
 * a token stolen out of a log or a proxy is useful for minutes, not days.
 */
/** How long an access token (JWT) is accepted. */
export const ACCESS_TOKEN_TTL_MINUTES = 15;
/** How long a refresh token stays usable without being rotated. */
export const REFRESH_TOKEN_TTL_DAYS = 30;

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

/**
 * Horizon host for the fallback slot (Step 17).
 *
 * The primary endpoint is required and network-specific; this second one is
 * optional and defaults to where a locally-run Stellar node answers -
 * `stellar/quickstart` publishes Horizon on port 8000 - because a self-hosted
 * Horizon is also the realistic production answer for a failover. Nothing queries
 * it yet: it is a slot, so pointing the fallback at a real second host stays a
 * deployment change rather than a code change.
 */
export const DEFAULT_FALLBACK_HORIZON_URL = 'http://localhost:8000';

/**
 * Where a Testnet account is funded from (Step 19).
 *
 * Friendbot is Stellar's own Testnet faucet and the only funder that exists there - it
 * creates an account by paying it 10,000 XLM from its own account, so the newly created
 * keypair never needs to hold anything to be born. It is deliberately *not* the treasury
 * account the build sequence mentions for staging: a treasury is a funded account the
 * operator controls and tops up, and neither exists yet.
 *
 * The host is the service's own host rather than the Horizon host: `horizon-testnet`
 * serves friendbot at `/friendbot` while `friendbot.stellar.org` serves it at `/`, so the
 * configured value is the *request URL* and `friendbotAccountUrl()` only adds the `addr`
 * query parameter. Both hosts were verified live: `https://friendbot.stellar.org/?addr=G...`
 * and `https://horizon-testnet.stellar.org/friendbot?addr=G...` answer a funding request,
 * while `https://friendbot.stellar.org/friendbot?addr=G...` is a 404.
 */
export const DEFAULT_FRIENDBOT_URL = 'https://friendbot.stellar.org/';

/**
 * Resolves the funder's endpoint.
 *
 * Unset (or blank, which is what `STELLAR_FRIENDBOT_URL=` in an `.env` file produces)
 * means the public Testnet faucet - the same belt-and-braces split as
 * `resolveFallbackHorizonUrl`: the factory keeps producing something usable and
 * `validation.schema.ts` is the half that refuses the boot on a blank value.
 *
 * A trailing slash is *not* stripped here, unlike the Horizon fallback: this value is
 * parsed by `URL` rather than concatenated, and `new URL` treats `https://host` and
 * `https://host/` as the same address.
 */
export function resolveFriendbotUrl(override: string | undefined): string {
  const explicit = override?.trim();

  return explicit === undefined || explicit === '' ? DEFAULT_FRIENDBOT_URL : explicit;
}

/**
 * How long one account's provisioning may take before the flow gives up on it
 * (Step 19), in milliseconds.
 *
 * Provisioning runs inside the request that verified the phone number, so this number is
 * the tail latency added to a response the user is waiting for: registration completes in
 * milliseconds, and a 30-second ceiling is the point at which a caller is better served by
 * a success response (the account *is* activated - provisioning is not part of that fact)
 * and a second attempt later than by a request that hangs.
 *
 * Not a per-call timeout: the funder and Horizon have bounds of their own, and this is the
 * one on the whole sequence, because the failure mode that matters is a *sequence* of
 * calls each answering just inside their own limit.
 */
export const DEFAULT_PROVISIONING_TIMEOUT_MS = 30_000;

/**
 * How often the confirmation sweep runs (Step 28), in milliseconds. `0` means no schedule at all.
 *
 * Off by default, and that is a decision rather than an omission: the sweep is a background
 * process that writes *payment verdicts*, so a deployment switches it on deliberately
 * (`PAYMENTS_CONFIRMATION_INTERVAL_MS=5000`) instead of inheriting a timer nobody chose. It also
 * means a test run - which boots the real application, with the real worker, against the real
 * database - does not sweep the in-flight payments another test is asserting about.
 *
 * `0` disables the schedule without disabling the code: `PaymentsQueueService.enqueueConfirmation()`
 * runs one tick on demand, which is what an operator does when the sweep is off and a payment needs
 * an answer.
 *
 * Five seconds is the interesting value in production, and it is chosen against the network rather
 * than against a CPU budget: a Testnet ledger closes every ~5 seconds and Horizon ingests shortly
 * after, so polling faster than a ledger close mostly re-asks a question whose answer cannot have
 * changed. It is also the interval the README's Step 28 audit run used.
 */
export const DEFAULT_CONFIRMATION_INTERVAL_MS = 0;

/**
 * How often the reconciliation sweep runs (Step 31), in milliseconds. `0` means no schedule at all.
 *
 * Off by default for the same reason the confirmation sweep is, and one more: reconciliation reads
 * *every* account's Horizon balance, so switching it on is a standing load against the network as
 * well as a background process. A deployment opts in (`RECONCILIATION_INTERVAL_MS=60000`) rather than
 * inheriting a timer, and a test run that boots the real application does not poll the real network
 * on a schedule behind the assertions.
 *
 * `0` disables the schedule without disabling the code: `LedgerQueueService.enqueueReconciliation()`
 * runs one sweep on demand, which is what a test forcing a mismatch (or an operator who wants an
 * answer now) does.
 *
 * Sixty seconds is the value to use in production. It is chosen against what a sweep costs rather
 * than against how fast a balance can drift: a drift that matters is one that persists, a single
 * Testnet ledger closes in ~5 seconds, and a minute keeps the read load on Horizon modest while still
 * catching a broken credit long before a user would notice.
 */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 0;

/**
 * Resolves the fallback Horizon host.
 *
 * Unset (or blank, which is what `STELLAR_HORIZON_FALLBACK_URL=` in an `.env`
 * file produces) means the local-node default - the same belt-and-braces split as
 * `readBooleanFlag`: the factory keeps working on a surprising value, and
 * `validation.schema.ts` refuses the boot, so nothing reaches a running app by
 * accident. A trailing slash is stripped because the value is concatenated into
 * URLs downstream.
 */
export function resolveFallbackHorizonUrl(override: string | undefined): string {
  const explicit = override?.trim();
  const resolved =
    explicit === undefined || explicit === '' ? DEFAULT_FALLBACK_HORIZON_URL : explicit;

  return resolved.replace(/\/+$/, '');
}

export default function configuration() {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),

    /**
     * HTTP request-body limits.
     *
     * The JSON ceiling is explicit and configurable because the alternative - leaving
     * `express.json()` at its implicit `100kb` default - is a limit nobody chose and nobody can
     * find. `main.ts` hands this value to `app.useBodyParser('json', ...)`; the urlencoded, text
     * and raw parsers are not registered at all, because every endpoint here speaks JSON (see
     * `src/common/http/body-parser.ts`). `validation.schema.ts` rejects a value that is not a byte
     * size, so `BODY_LIMIT_JSON=nope` fails the boot naming the variable rather than becoming a
     * parser that throws on every request.
     */
    http: {
      jsonBodyLimit: process.env.BODY_LIMIT_JSON?.trim() || DEFAULT_JSON_BODY_LIMIT,
    },

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

    /**
     * JWT signing configuration (Step 16).
     *
     * The secret is the only environment variable here: it is per-environment and
     * must never be shared, while the two lifetimes are product rules that belong in
     * the code where a change shows up in review (the OTP block above makes the same
     * argument). `validation.schema.ts` floors the secret at 32 characters, because
     * an HMAC key shorter than its output is the one way to weaken HS256 while still
     * looking configured.
     */
    auth: {
      jwtSecret: process.env.JWT_SECRET as string,
      /** Lifetime of an access token, in minutes. See `ACCESS_TOKEN_TTL_MINUTES`. */
      accessTokenTtlMinutes: ACCESS_TOKEN_TTL_MINUTES,
      /** Lifetime of a refresh token, in days. See `REFRESH_TOKEN_TTL_DAYS`. */
      refreshTokenTtlDays: REFRESH_TOKEN_TTL_DAYS,
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

    /**
     * Transaction PIN policy (Step 34a), including the step-up token that proves one was
     * given.
     *
     * Under its own group rather than inside `auth`, because none of it is about a
     * session: the PIN is the second factor a payment requires, and the token below is
     * how that proof travels from the verify endpoint to the payments endpoint. See
     * `PIN_MAX_ATTEMPTS` and `STEP_UP_TOKEN_TTL_MINUTES` for how the numbers were chosen.
     */
    pin: {
      length: PIN_LENGTH,
      maxAttempts: PIN_MAX_ATTEMPTS,
      lockoutMinutes: PIN_LOCKOUT_MINUTES,
      stepUpTokenTtlMinutes: STEP_UP_TOKEN_TTL_MINUTES,
    },

    /**
     * Password policy (Step 34b).
     *
     * Under its own group for the same reason the PIN's is: the service, the DTO's
     * `@MinLength` and the message a refused password carries all have to agree, and one
     * key is how they do. See `PASSWORD_MIN_LENGTH` for why eight and `secret-hash.ts` for
     * why a password is hashed with a stronger work factor than a PIN.
     */
    password: {
      minLength: PASSWORD_MIN_LENGTH,
      maxLength: PASSWORD_MAX_LENGTH,
    },

    /**
     * Email policy (Step 34c).
     *
     * `from` is the address a verification or receipt email is sent *from*; the provider
     * that sends it is the `EMAIL_SENDER` binding and the wording lives in
     * `NotificationsService` beside the SMS wording. See `DEFAULT_EMAIL_FROM`.
     */
    email: {
      from: process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
      /**
       * Which `EmailSender` the app binds (Step 34c follow-up).
       *
       * `'resend'` (the default) sends real mail through Resend; `'mailtrap'` hands every message
       * to a Mailtrap Email-Testing sandbox and is refused when `NODE_ENV=production` by the
       * validation schema; `'smtp'` sends through a real SMTP relay (see `notifications.smtp`) and
       * `'sendgrid'` through SendGrid's own relay (see `notifications.sendgrid`), which staging
       * uses to reach arbitrary inboxes. Read in `createEmailSender`, the one place the senders are
       * chosen between.
       */
      sender: process.env.EMAIL_SENDER ?? 'resend',
    },

    /**
     * Recipient directory policy (Step 21).
     *
     * Under its own group rather than inside `payments`, because it is not about payments yet:
     * it is the cost of asking who someone is, and Steps 23-29 will add their own keys beside
     * it when they have something to configure. See `RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW` for
     * why the limit exists and how the number was chosen.
     */
    recipients: {
      lookupRequestsPerWindow: RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW,
      lookupWindowSeconds: RECIPIENT_LOOKUP_WINDOW_SECONDS,
    },

    /**
     * Idempotency (Step 24): how long a payment's key answers for.
     *
     * See `IDEMPOTENCY_TTL_SECONDS` for why it is a day; the read is here rather than in the
     * interceptor so that the value has the same route to a caller as every other tunable.
     */
    idempotency: {
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
    },

    /** Outbound providers: SMS via Africa's Talking and email via Resend, Mailtrap, SMTP or SendGrid. */
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
      /**
       * Outbound email via Resend (Step 34c), behind `EMAIL_SENDER`.
       *
       * Required and without a default: it is the key Resend identifies the account by, so there
       * is nothing safe to fall back to and a missing value has to fail at boot rather than at the
       * first verification email. See `ResendEmailSender`.
       */
      resend: {
        apiKey: process.env.RESEND_API_KEY as string,
      },
      /**
       * Outbound email via Mailtrap's Email-Testing sandbox, behind `EMAIL_SENDER` (Step 34c
       * follow-up). Selected only in local development - `EMAIL_SENDER=mailtrap` - and refused in
       * production by the validation schema, so a real verification code cannot end up in a
       * sandbox inbox.
       *
       * Host and port default to Mailtrap's own; the username and the password are the per-inbox
       * SMTP credentials and are read only when the sender is selected (see `MailtrapEmailSender`).
       * Left unset for Resend, which needs none of them.
       */
      mailtrap: {
        host: process.env.MAILTRAP_HOST ?? 'sandbox.smtp.mailtrap.io',
        port: Number(process.env.MAILTRAP_PORT ?? 2525),
        username: process.env.MAILTRAP_USERNAME,
        password: process.env.MAILTRAP_PASSWORD,
      },
      /**
       * Outbound email via a real SMTP relay, behind `EMAIL_SENDER` (Step 34c follow-up).
       * Selected with `EMAIL_SENDER=smtp` wherever mail has to reach arbitrary external inboxes
       * without a verified Resend domain - a staging environment, typically.
       *
       * Unlike `mailtrap`, none of the four has a default: there is no such thing as "the" SMTP
       * server, so an unset value stays `undefined` and `SmtpEmailSender` reports exactly what is
       * missing at send time. All four are read only when the sender is selected; Resend and
       * Mailtrap need none of them.
       */
      smtp: {
        host: process.env.SMTP_HOST,
        // `SMTP_PORT` arrives as a string via `process.env`; `undefined` when unset so the sender
        // can tell "not configured" from a real port rather than reading `Number('')` as 0.
        port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
        username: process.env.SMTP_USERNAME,
        password: process.env.SMTP_PASSWORD,
      },
      /**
       * Outbound email via SendGrid's SMTP relay, behind `EMAIL_SENDER` (Step 34c follow-up).
       * Selected with `EMAIL_SENDER=sendgrid`, which a staging or development environment uses to
       * reach arbitrary external inboxes from a *single-sender-verified* address - SendGrid
       * confirms one from-address by email link, so nothing here needs a sending domain or the
       * SPF/DKIM records a verified Resend domain would.
       *
       * Only the API key is configuration. SendGrid's relay host (`smtp.sendgrid.net`), its port
       * (587) and the literal `apikey` username are the same for every account, so
       * `SendgridEmailSender` holds them rather than reading them from here - there is no host an
       * operator could mistype or repoint. Left unset, the key stays `undefined` and the sender
       * reports it missing at send time; Resend, Mailtrap and the generic SMTP relay need none of it.
       */
      sendgrid: {
        apiKey: process.env.SENDGRID_API_KEY,
      },
    },

    /** Error reporting. */
    sentry: {
      dsn: process.env.SENTRY_DSN as string,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    },

    /**
     * AWS credentials and the KMS master key that wraps Stellar secret seeds
     * (Step 18).
     *
     * `endpointUrl` is unset in every normal deployment, and then the SDK talks to the
     * regional endpoint it derives from `region`. Set, it redirects every KMS call -
     * wrap and unwrap alike - to something else, which in practice means a local
     * emulator (LocalStack publishes KMS on http://localhost:4566). The validation
     * schema refuses a value once `NODE_ENV=production`: a master key living in an
     * emulator while `AWS_KMS_KEY_ID` still names an AWS key is a custody failure, not a
     * convenience.
     */
    aws: {
      region: process.env.AWS_REGION as string,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      kmsKeyId: process.env.AWS_KMS_KEY_ID as string,
      endpointUrl: process.env.AWS_ENDPOINT_URL,
    },

    /** Stellar network selection. */
    stellar: {
      network: process.env.STELLAR_NETWORK as string,
      horizonUrl: process.env.STELLAR_HORIZON_URL as string,
      /**
       * Second Horizon host for the same network: the failover slot, unused as of
       * Step 17 (see `DEFAULT_FALLBACK_HORIZON_URL`).
       */
      fallbackHorizonUrl: resolveFallbackHorizonUrl(process.env.STELLAR_HORIZON_FALLBACK_URL),
      /**
       * The issuer whose USDC every wallet is given a trustline for (Step 19).
       *
       * An issuer is half of an asset's identity on Stellar: `USDC:GBBD...` and
       * `USDC:GDHU...` are two different assets that happen to share a code, so this is a
       * required, network-specific value rather than a constant. Testnet's issuer is
       * Circle's own Testnet account, and the same code on the public network is a
       * different key - which is exactly why the schema demands a key and not a name.
       */
      usdcIssuer: process.env.STELLAR_USDC_ISSUER as string,
      /** Where a Testnet account is funded from. See `DEFAULT_FRIENDBOT_URL`. */
      friendbotUrl: resolveFriendbotUrl(process.env.STELLAR_FRIENDBOT_URL),
      /** Wall-clock ceiling on one account's provisioning. See `DEFAULT_PROVISIONING_TIMEOUT_MS`. */
      provisioningTimeoutMs: Number(
        process.env.STELLAR_PROVISIONING_TIMEOUT_MS ?? DEFAULT_PROVISIONING_TIMEOUT_MS,
      ),
    },

    /** The payments queue's own settings (Step 28). */
    payments: {
      /**
       * How often the confirmation sweep runs. See `DEFAULT_CONFIRMATION_INTERVAL_MS` for why the
       * default is off and why five seconds is the value to use in production.
       */
      confirmationIntervalMs: Number(
        process.env.PAYMENTS_CONFIRMATION_INTERVAL_MS ?? DEFAULT_CONFIRMATION_INTERVAL_MS,
      ),
    },

    /** The ledger (reconciliation) sweep's own settings (Step 31). */
    ledger: {
      /**
       * How often the reconciliation sweep runs. See `DEFAULT_RECONCILIATION_INTERVAL_MS` for why the
       * default is off and why a minute is the value to use in production.
       */
      reconciliationIntervalMs: Number(
        process.env.RECONCILIATION_INTERVAL_MS ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
      ),
    },
  };
}

/**
 * The shape this factory returns - what `ConfigModule` exposes and what
 * `main.ts` works with at boot, derived from the factory itself so the two cannot
 * drift.
 */
export type AppConfig = ReturnType<typeof configuration>;
