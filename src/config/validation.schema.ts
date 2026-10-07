import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateBy,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { isSupportedCountry } from 'libphonenumber-js';

/**
 * Recognised `NODE_ENV` values.
 */
export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Stellar networks the API can be pointed at.
 */
export enum StellarNetwork {
  Testnet = 'TESTNET',
  Public = 'PUBLIC',
}

/**
 * Providers the `EMAIL_SENDER` binding can choose between (Step 34c follow-up).
 *
 * `Resend` is the real sender a deployment uses by default; `Mailtrap` is the local
 * Email-Testing sandbox; `Smtp` is any real SMTP relay (Gmail, a corporate server); and
 * `Sendgrid` is SendGrid's own SMTP relay, whose host, port and `apikey` username are pinned
 * inside `SendgridEmailSender` so an environment can reach arbitrary inboxes from a
 * single-sender-verified address with no domain and no DNS. The four are an enum rather than a
 * free string so a typo (`Mailtrap`, `mailtrap `) is a boot error naming `EMAIL_SENDER`, not a
 * silent fall-through to Resend.
 *
 * `Mailtrap` and the real relays (`Smtp`, `Sendgrid`) are deliberately separate values rather
 * than one "SMTP" name: the guard below refuses the *sandbox* in production while allowing a
 * real relay, and that distinction is only expressible if the sandbox keeps its own name.
 */
export enum EmailProvider {
  Resend = 'resend',
  Mailtrap = 'mailtrap',
  Smtp = 'smtp',
  Sendgrid = 'sendgrid',
}

/**
 * Environment variables that hold a number but arrive as strings via
 * `process.env`, and therefore need coercing before validation.
 */
/**
 * Environment variables that hold a number but arrive as strings via
 * `process.env`, and therefore need coercing before validation.
 *
 * `STELLAR_PROVISIONING_TIMEOUT_MS` is listed because `@IsInt()` needs a number to be
 * able to say anything useful: left as a string it would fail as "must be an integer
 * number" for *every* value, including correct ones.
 */
const NUMERIC_KEYS = [
  'PORT',
  'STELLAR_PROVISIONING_TIMEOUT_MS',
  'PAYMENTS_CONFIRMATION_INTERVAL_MS',
  'RECONCILIATION_INTERVAL_MS',
  'MAILTRAP_PORT',
  'SMTP_PORT',
] as const;

/**
 * Environment variables that hold a boolean but arrive as strings via
 * `process.env`.
 *
 * Only the literals `true`/`false` are coerced. Anything else is left alone so
 * `@IsBoolean()` rejects it: `ENABLE_SWAGGER=flase` failing at boot with the
 * variable named is a much better outcome than the docs quietly staying on (or
 * off) because the typo was coerced to the wrong thing.
 */
const BOOLEAN_KEYS = ['ENABLE_SWAGGER'] as const;

const BOOLEAN_LITERALS: Readonly<Record<string, boolean>> = {
  true: true,
  false: false,
};

/**
 * One or more browser origins - `scheme://host[:port]`, comma-separated.
 *
 * Shapes a browser never puts in the `Origin` header are rejected on purpose: a
 * trailing slash (`http://localhost:5173/`), a bare host (`localhost:5173`) and
 * `*` are all compared literally by the CORS middleware, so accepting them would
 * mean shipping a frontend that cannot reach the API and only finding out at
 * request time.
 */
const CORS_ALLOWED_ORIGINS_PATTERN =
  /^\s*https?:\/\/[^\s,/:*]+(?::\d{1,5})?\s*(?:,\s*https?:\/\/[^\s,/:*]+(?::\d{1,5})?\s*)*$/;

/**
 * An AWS region, as used by `AWS_REGION` and inside a KMS key ARN: `eu-west-1`,
 * `us-east-1`, `ap-southeast-2`.
 *
 * Only the shape. Whether the region exists, and whether the key lives in it, is what
 * the boot probe asks KMS (`KmsKeyWrapper.onModuleInit`). The shape is still worth
 * checking, because a blank or mistyped region is otherwise silent: the SDK falls back
 * to a default of its own, and a key in another region then comes back as
 * `NotFoundException` - which reads like a deleted key rather than a region mistake.
 */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/**
 * A KMS key reference, in the three forms AWS accepts - and therefore the three this
 * app has to accept, since any of them can come from a real deployment:
 *
 * - a key ARN - `arn:aws:kms:eu-west-1:123456789012:key/<uuid>`
 * - an alias - `alias/cashping-seeds` (or the full `arn:...:alias/...` form)
 * - a bare key id - `1234abcd-12ab-34cd-56ef-1234567890ab`
 *
 * The ARN's region is deliberately *not* compared to `AWS_REGION` here: the schema
 * checks one variable at a time, and the comparison belongs where it can also say which
 * region the key actually resolved to - the boot probe, which has KMS's own answer.
 */
const AWS_KMS_KEY_ID_PATTERN =
  /^(?:arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(?:key\/[0-9a-fA-F-]{36}|alias\/[A-Za-z0-9/_-]+)|alias\/[A-Za-z0-9/_-]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * A Stellar account address (`STELLAR_USDC_ISSUER`, Step 19): a `G`, 55 more characters
 * of base32, and nothing else.
 *
 * Checked as a shape *and* as a checksum? No - the checksum is a job for the SDK, which
 * this app already depends on, and the schema's job is to be readable. What it must catch
 * is the two mistakes that reach a config file in practice: the `S...` *secret* key that
 * the same dashboard shows next to the public one (an issuer that is a secret is a key
 * leak in a log and an asset nobody can hold), and a truncated paste. Both are wrong
 * under this pattern, and the error message says which shape is wanted.
 *
 * Case matters here and is not normalised: Stellar addresses are uppercase base32, and a
 * lower-case one would be accepted by nothing downstream, so accepting it here would only
 * postpone the failure to the first trustline build.
 */
const STELLAR_ACCOUNT_ID_PATTERN = /^G[A-Z2-7]{55}$/;

/**
 * Validates a phone-number region against the metadata `libphonenumber-js`
 * actually ships, rather than against the shape of a country code.
 *
 * A two-letter check would accept `XX`, which only fails later: the normalizer
 * would hand it to the parser and every national-format number would come back
 * unparseable - i.e. a typo here would look like "our users' phone numbers are
 * invalid" at the registration endpoint instead of a boot-time error.
 *
 * `validator` is an **object** with a `validate` method, which is the shape
 * `registerDecorator` supports. A bare function also typechecks
 * (`ValidateByOptions.validator` is `ValidatorConstraintInterface | Function`)
 * but is treated as a constraint *class* and instantiated with `new`, so an arrow
 * function reaches `new` and throws the first time a value is validated - a
 * boot-time crash that no type can catch. The object form is the one that runs.
 *
 * `PHONE_DEFAULT_REGION` is normalised to upper case by `configuration()` after
 * this runs, so any case is accepted here.
 */
const IsSupportedCountryCode = (): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isSupportedCountryCode',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isSupportedCountry(value.trim().toUpperCase()),
      },
    },
    {
      message:
        'PHONE_DEFAULT_REGION must be an ISO 3166-1 alpha-2 country code libphonenumber knows, e.g. GH or NG',
    },
  );

/**
 * class-validator schema for environment variables (Step 4).
 *
 * Any property without `@IsOptional()` is required. When one is missing the app
 * refuses to boot with an error that names the variable, rather than starting up
 * and failing mysteriously later.
 *
 * Note on decorator order for the required properties below: decorators apply
 * bottom-up, so the `@IsNotEmpty()` written *last* registers *first*. Combined
 * with `stopAtFirstError` that makes "should not be empty" the reported failure
 * for a missing variable, instead of a confusing "must be a URL address".
 * `validation.schema.spec.ts` locks that behaviour in.
 */
export class EnvironmentVariables {
  // --- Runtime -------------------------------------------------------------
  @IsOptional()
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 3000;

  // --- CORS ----------------------------------------------------------------
  /**
   * Comma-separated origins allowed to call the API from a browser.
   *
   * Optional, and deliberately without a default here: `configuration()` owns the
   * fallback, so the local frontend origins are defined once.
   *
   * A supplied value is checked strictly - see `CORS_ALLOWED_ORIGINS_PATTERN`.
   */
  @IsOptional()
  @Matches(CORS_ALLOWED_ORIGINS_PATTERN, {
    message:
      'CORS_ALLOWED_ORIGINS must be a comma-separated list of origins with a scheme and no trailing slash or path, e.g. http://localhost:3000,http://localhost:5173',
  })
  CORS_ALLOWED_ORIGINS?: string;

  // --- Interactive docs (Swagger UI) ---------------------------------------
  /**
   * Whether the Swagger UI (`/api/docs`) and the OpenAPI document
   * (`/api/docs-json`) are served.
   *
   * Defaults to true, which is what local dev, the e2e suite and the frontend
   * hand-off all want. Production sets it to false - see `.env.example`.
   *
   * No default on the value itself beyond the class property below:
   * `configuration()` owns the fallback so the flag has one definition.
   */
  @IsOptional()
  @IsBoolean()
  ENABLE_SWAGGER: boolean = true;

  // --- Database ------------------------------------------------------------
  @IsUrl({ protocols: ['postgresql', 'postgres'], require_tld: false })
  @IsNotEmpty()
  DATABASE_URL!: string;

  // --- Redis ---------------------------------------------------------------
  @IsUrl({ protocols: ['redis', 'rediss'], require_tld: false })
  @IsNotEmpty()
  REDIS_URL!: string;

  // --- Auth ----------------------------------------------------------------
  /**
   * The HS256 signing key (Step 16).
   *
   * Floored at 32 characters, which is the length of the digest the algorithm
   * produces: a shorter key is the one way to weaken the signature while still
   * looking configured, and it is invisible at runtime - tokens would verify fine
   * right up until someone brute-forces the key offline from a single captured
   * token. `openssl rand -base64 32` is the intended way to fill it in.
   *
   * A floor and not a length *check*: base64 output is 44 characters, but any 32+
   * character string is a legitimate high-entropy key, and rejecting a good key
   * because it was not generated the way the example suggests would be a worse
   * failure than accepting it.
   */
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters ($constraint1)' })
  @IsNotEmpty()
  JWT_SECRET!: string;

  // --- Phone numbers -------------------------------------------------------
  /**
   * Region a national-format phone number is read against (`024 123 4567` ->
   * `+233241234567`). Optional, and without a default here: `configuration()`
   * owns the fallback, so the market this API is built for is defined once.
   */
  @IsOptional()
  @IsSupportedCountryCode()
  PHONE_DEFAULT_REGION?: string;

  // --- Notifications (Africa's Talking) ------------------------------------
  @IsNotEmpty()
  AFRICASTALKING_API_KEY!: string;

  @IsOptional()
  AFRICASTALKING_USERNAME: string = 'sandbox';

  /**
   * Overrides the Africa's Talking host the SMS client calls. Normally unset -
   * `AFRICASTALKING_USERNAME` already picks between the sandbox and live hosts -
   * so this exists to point the client at a stub in a test.
   *
   * `require_protocol` because `fetch` needs a scheme: a value like
   * `api.sandbox.africastalking.com` would otherwise boot fine and fail as a
   * request-time `TypeError`, which is the least useful place to learn about a
   * typo.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  AFRICASTALKING_BASE_URL?: string;

  // --- Notifications (Resend, email) ---------------------------------------
  /**
   * API key from the Resend dashboard (Step 34c), behind `EMAIL_SENDER`.
   *
   * Required and without a default, for the same reason `AFRICASTALKING_API_KEY` is: it is the
   * secret the provider identifies the account by, so a missing value is a boot-time error rather
   * than a verification email that quietly cannot be sent.
   */
  @IsNotEmpty()
  RESEND_API_KEY!: string;

  // --- Notifications (email provider selection) ----------------------------
  /**
   * Which `EmailSender` the app binds (Step 34c follow-up).
   *
   * Optional; `configuration()` defaults it to `resend`, so production needs no value and gets
   * the real provider. `mailtrap` routes mail to the Mailtrap Email-Testing sandbox for local
   * development - see `assertEmailSenderIsUsable` for why it is refused in production. `smtp`
   * sends through a real SMTP relay (Gmail, a corporate server) and `sendgrid` through
   * SendGrid's own relay; both are senders a staging environment uses to reach arbitrary
   * inboxes without verifying a domain in Resend, and both are real senders, so the guard
   * leaves them alone. Missing credentials are not checked here; the sender reports them at
   * send time (see `MailtrapEmailSender`, `SmtpEmailSender`, `SendgridEmailSender`).
   */
  @IsOptional()
  @IsEnum(EmailProvider)
  EMAIL_SENDER?: EmailProvider;

  /**
   * Mailtrap Email-Testing SMTP settings (Mailtrap -> Email Testing -> Inbox -> SMTP settings).
   *
   * Optional as a group, because they are read only when `EMAIL_SENDER=mailtrap`. Host and port
   * have defaults in `configuration()`; the credentials do not, and their absence is a send-time
   * `EmailDeliveryError` rather than a boot error.
   */
  @IsOptional()
  MAILTRAP_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  MAILTRAP_PORT?: number;

  @IsOptional()
  MAILTRAP_USERNAME?: string;

  @IsOptional()
  MAILTRAP_PASSWORD?: string;

  /**
   * Generic SMTP relay settings, read only when `EMAIL_SENDER=smtp` (see `SmtpEmailSender`).
   *
   * Unlike Mailtrap's, none of the four has a default in `configuration()`: there is no such
   * thing as "the" SMTP server, so a half-filled group is a send-time `EmailDeliveryError`
   * naming what is missing rather than a connection to a host nobody chose. `SMTP_PORT` is
   * coerced from its string form by `NUMERIC_KEYS`, like `MAILTRAP_PORT`.
   */
  @IsOptional()
  SMTP_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  SMTP_PORT?: number;

  @IsOptional()
  SMTP_USERNAME?: string;

  @IsOptional()
  SMTP_PASSWORD?: string;

  /**
   * SendGrid's API key, read only when `EMAIL_SENDER=sendgrid` (see `SendgridEmailSender`).
   *
   * Optional, like the SMTP group and for the same reason: `sendgrid` is opt-in (production
   * defaults to Resend), and refusing to boot because the key is unset would be worse than a
   * send failing with a reason naming it. SendGrid's relay authenticates with the literal
   * username `apikey` and this key as the password, so the key is the only secret the sender
   * needs - the host, the port and the username are fixed facts about SendGrid and live in the
   * sender rather than in configuration.
   */
  @IsOptional()
  SENDGRID_API_KEY?: string;

  // --- Error reporting (Sentry) --------------------------------------------
  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  SENTRY_DSN!: string;

  @IsOptional()
  SENTRY_ENVIRONMENT?: string;

  // --- AWS / KMS -----------------------------------------------------------
  /**
   * Region the SDK signs for, and the region the key has to live in.
   *
   * KMS keys are regional, so this is not only a routing detail: a key from another region
   * is invisible from here, and AWS reports that as `NotFoundException` - no hint that the
   * region is the problem. The boot probe is what compares the two for real; this is the
   * half that stops a blank or mistyped region from silently becoming a default of the
   * SDK's choosing.
   */
  @Matches(AWS_REGION_PATTERN, {
    message: 'AWS_REGION must be an AWS region such as eu-west-1',
  })
  @IsNotEmpty()
  AWS_REGION!: string;

  @IsNotEmpty()
  AWS_ACCESS_KEY_ID!: string;

  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY!: string;

  /**
   * The KMS master key that wraps per-account data keys (Step 18).
   *
   * Required, and required to *look* like a key reference: every account's seed is
   * encrypted under it, so an empty or obviously-placeholder value is a custody failure
   * waiting for the first registration rather than a missing nicety.
   *
   * A placeholder that is *shaped* like a real ARN still boots - nothing here can tell it
   * apart from a real key - and then fails closed at the boot probe and at the first
   * custody call. That is deliberate: `docker-compose.yml` runs the API with a
   * shape-valid placeholder so the stack starts without AWS credentials, and the
   * consequence is a loud log line rather than a silently unusable wallet.
   */
  @Matches(AWS_KMS_KEY_ID_PATTERN, {
    message:
      'AWS_KMS_KEY_ID must be a KMS key ARN, a key id or an alias (for example arn:aws:kms:eu-west-1:123456789012:key/...)',
  })
  @IsNotEmpty()
  AWS_KMS_KEY_ID!: string;

  /**
   * [optional] A non-AWS KMS endpoint (Step 18).
   *
   * Unset in every normal deployment: the SDK then uses the regional endpoint it derives
   * from `AWS_REGION`. Set, it redirects every KMS call to that address, which is how a
   * local emulator stands in for AWS - LocalStack publishes KMS on
   * `http://localhost:4566`, and the same variable is what the opt-in custody
   * integration spec points at.
   *
   * Two constraints, both from how the value is used rather than from taste:
   *
   * - blank is not a value, exactly as for `STELLAR_HORIZON_FALLBACK_URL`. A variable
   *   that was typed and never filled in is a mistake worth naming at boot.
   * - `require_protocol`, because the SDK parses this into a URL: a bare host would boot
   *   and then fail at the first KMS call.
   * - `require_tld: false`, unlike the Horizon URL: the thing this variable exists for is
   *   an emulator, and an emulator is reached at `localhost`, `127.0.0.1` or
   *   `host.docker.internal` - none of which has a top-level domain to require.
   *
   * The fourth constraint is not expressible in a decorator: `validate` refuses this
   * variable outright when `NODE_ENV=production`.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false })
  AWS_ENDPOINT_URL?: string;

  // --- Stellar -------------------------------------------------------------
  @IsEnum(StellarNetwork)
  @IsNotEmpty()
  STELLAR_NETWORK!: StellarNetwork;

  @IsUrl()
  @IsNotEmpty()
  STELLAR_HORIZON_URL!: string;

  /**
   * Second Horizon host for the same network, used as a fallback (Step 17).
   *
   * Optional, with two constraints that come from how the value is used rather
   * than from taste:
   *
   * - blank is not a value. Leaving the variable unset keeps the local-node
   *   default (`configuration.ts`), while an empty one is refused at boot - a
   *   variable that was typed but not filled in is a mistake worth naming, the
   *   same way an empty `AFRICASTALKING_BASE_URL` is.
   * - `require_protocol` for the same reason it is set on that one: the SDK parses
   *   this into a `URL`, so `horizon.example.com` would boot and then fail at the
   *   first account load.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  STELLAR_HORIZON_FALLBACK_URL?: string;

  /**
   * The USDC issuer every new wallet gets a trustline for (Step 19).
   *
   * Required, and required to be an *account address*: a trustline names the pair
   * (code, issuer), and without the issuer half there is no asset to trust. Testnet and
   * public want different values, which is the whole reason this is configuration and not
   * a constant - Circle issues on both networks from different keys, and a trustline for
   * the wrong one is a wallet that cannot receive the USDC the ledger pays out.
   *
   * A `S...` secret is refused rather than accepted-and-trimmed: see
   * `STELLAR_ACCOUNT_ID_PATTERN`.
   */
  @Matches(STELLAR_ACCOUNT_ID_PATTERN, {
    message:
      'STELLAR_USDC_ISSUER must be a Stellar account address (G...), for example the USDC issuer for this network',
  })
  @IsNotEmpty()
  STELLAR_USDC_ISSUER!: string;

  /**
   * [optional] Where a Testnet account is funded from (Step 19).
   *
   * Optional, with the same two constraints as `STELLAR_HORIZON_FALLBACK_URL` and for the
   * same reasons: blank is not a value (unset means the public Testnet faucet, an empty
   * variable is a typo), and `require_protocol` because the value is parsed into a `URL` -
   * `friendbot.stellar.org` would boot and then fail as a request-time `TypeError`
   * (`Invalid URL`), which is the least useful place to learn about a missing scheme.
   *
   * Unlike the Horizon fallback there is no `require_tld: false`: a local Stellar node
   * publishes Horizon on `localhost:8000` but friendbot is a *service*, and the local
   * quickstart container serves it from Horizon's own path - which is expressible as a
   * host with a TLD or as a literal address.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  STELLAR_FRIENDBOT_URL?: string;

  /**
   * [optional] Wall-clock ceiling on one account's provisioning (Step 19), in
   * milliseconds.
   *
   * A number rather than a fixed constant because it is a *deployment* judgement: on
   * Testnet the funder is a shared public faucet that is occasionally slow, and in
   * production it is the treasury payment this app sends. Ten minutes is the upper bound
   * `@Max()` allows - beyond that, waiting is not a strategy - and the lower bound is one
   * millisecond, not zero: zero would mean "give up immediately", which reads like a
   * working timeout and behaves like a disabled one.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600_000)
  STELLAR_PROVISIONING_TIMEOUT_MS?: number;

  /**
   * [optional] How often the confirmation sweep runs (Step 28), in milliseconds.
   *
   * Zero is a legal value and it means "no schedule": the sweep's code is still there
   * (`PaymentsQueueService.enqueueConfirmation()`), and a deployment that has not switched the
   * timer on simply has to run a tick by hand. That is deliberate - a background process that
   * writes payment verdicts is opted into, not inherited - so `@Min(0)` rather than the
   * provisioning timeout's `@Min(1)`, where zero would read as a working timeout and behave like
   * a disabled one.
   *
   * The upper bound is an hour: anything slower is not a poll of payments in flight, and a
   * deployment that wants one should schedule it outside this API.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3_600_000)
  PAYMENTS_CONFIRMATION_INTERVAL_MS?: number;

  /**
   * [optional] How often the reconciliation sweep runs (Step 31), in milliseconds.
   *
   * Zero means "no schedule", exactly as it does for the confirmation sweep above, and for the same
   * reason: reconciliation is a background process that reads every account's balance from Horizon, so
   * it is opted into rather than inherited. `@Min(0)` and the same one-hour ceiling as the
   * confirmation interval - a sweep slower than an hour is not reconciliation, it is a report a
   * deployment should schedule outside this API.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3_600_000)
  RECONCILIATION_INTERVAL_MS?: number;
}

/**
 * Collects every constraint message, including those on nested objects.
 */
function describe(error: ValidationError, parent?: string): string[] {
  const path = parent ? `${parent}.${error.property}` : error.property;
  const own = Object.values(error.constraints ?? {});
  const children = error.children ?? [];

  if (children.length === 0) {
    return own;
  }

  return [...own, ...children.flatMap((child) => describe(child, path))];
}

/**
 * Renders validation failures as a multi-line, human-readable report.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  const lines = errors.flatMap((error) => describe(error)).map((message) => `  - ${message}`);

  return [
    'Invalid environment configuration - the API refused to start.',
    'Fix the following in your .env (see .env.example):',
    ...lines,
  ].join('\n');
}

/**
 * Refuses `AWS_ENDPOINT_URL` in production (Step 18).
 *
 * A cross-variable rule has nowhere to live in a per-property decorator, and this one has
 * to fail at boot: the variable exists so a developer can point KMS at a local emulator,
 * and in production the same value would send every wrap and unwrap to an endpoint
 * outside AWS while `AWS_KMS_KEY_ID` still names an AWS key. Seeds would be encrypted
 * under a master key that is not the one the configuration claims - a custody failure
 * that no amount of well-formed key-id syntax would reveal.
 *
 * `NODE_ENV` is compared as the raw string rather than the validated enum, because this
 * runs before validation: it has to fire on exactly the value the operator wrote.
 */
function assertEndpointIsNotSelectedForProduction(candidate: Record<string, unknown>): void {
  const endpoint = candidate['AWS_ENDPOINT_URL'];

  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return;
  }

  if (candidate['NODE_ENV'] !== NodeEnvironment.Production) {
    return;
  }

  throw new Error(
    [
      'Invalid environment configuration - the API refused to start.',
      'Fix the following in your .env (see .env.example):',
      '  - AWS_ENDPOINT_URL is set while NODE_ENV=production.',
      '    It exists to point KMS at a local emulator in development. In production it would',
      '    send every key-custody call to that endpoint while AWS_KMS_KEY_ID still names an',
      '    AWS key. Unset it - or fix NODE_ENV, if this process is not production.',
    ].join('\n'),
  );
}

/**
 * Refuses the Mailtrap sandbox in production (Step 34c follow-up).
 *
 * `EMAIL_SENDER` defaults to `resend`, so a deployment is real mail unless someone deliberately
 * opts out - but "unless someone" is exactly the failure this guards: a forgotten variable, or a
 * staging `.env` copied to production, would route every verification code and payment receipt
 * into a sandbox inbox nobody reads, while the API answered 2xx and looked healthy. Refusing at
 * boot makes that a deploy-time error rather than silent mail loss.
 *
 * The same shape as `assertEndpointIsNotSelectedForProduction`, and a cross-variable rule for the
 * same reason: `EMAIL_SENDER=mailtrap` alone is fine (it is what local development wants), and
 * `NODE_ENV=production` alone is fine; it is the pair that cannot stand.
 *
 * Only the Mailtrap *sandbox* is refused, and deliberately so: `resend` (the default) and `smtp`
 * are both real senders that actually deliver, so both are production-legal. The guard names
 * exactly one value because exactly one value loses mail.
 *
 * `NODE_ENV` is compared as the raw string rather than the validated enum, because this runs
 * before validation: it has to fire on exactly the value the operator wrote.
 */
function assertEmailSenderIsUsable(candidate: Record<string, unknown>): void {
  if (candidate['EMAIL_SENDER'] !== EmailProvider.Mailtrap) {
    return;
  }

  if (candidate['NODE_ENV'] !== NodeEnvironment.Production) {
    return;
  }

  throw new Error(
    [
      'Invalid environment configuration - the API refused to start.',
      'Fix the following in your .env (see .env.example):',
      '  - EMAIL_SENDER=mailtrap is set while NODE_ENV=production.',
      "    Mailtrap is a local Email-Testing sandbox: it accepts mail and delivers none of it.",
      '    In production it would swallow every verification code and payment receipt.',
      '    Unset EMAIL_SENDER (the default is resend) - or fix NODE_ENV, if this is not',
      '    production.',
    ].join('\n'),
  );
}

/**
 * `ConfigModule.forRoot({ validate })` hook.
 *
 * Runs before the app boots: coerces numeric values, then enforces the schema.
 * Throwing here aborts bootstrap, which is the whole point of Step 4 - a missing
 * variable must be a boot-time error, not a runtime crash three requests in.
 */
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const candidate: Record<string, unknown> = { ...config };

  for (const key of NUMERIC_KEYS) {
    const raw = candidate[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      candidate[key] = Number(raw);
    }
  }

  for (const key of BOOLEAN_KEYS) {
    const raw = candidate[key];
    if (typeof raw === 'string') {
      // `?? raw` keeps an unrecognised value as the string it was, so
      // `@IsBoolean()` reports it below instead of it being coerced to `true`.
      candidate[key] = BOOLEAN_LITERALS[raw.trim().toLowerCase()] ?? raw;
    }
  }

  // Before the schema runs, so these report their own, more specific messages rather than
  // whatever the per-property decorators would say about the same values.
  assertEndpointIsNotSelectedForProduction(candidate);
  assertEmailSenderIsUsable(candidate);

  const validated = plainToInstance(EnvironmentVariables, candidate);
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
    // One message per variable instead of one per failed constraint, so a
    // missing DATABASE_URL reports "should not be empty" and not also
    // "must be a URL address".
    stopAtFirstError: true,
  });

  if (errors.length > 0) {
    throw new Error(formatValidationErrors(errors));
  }

  return validated;
}
