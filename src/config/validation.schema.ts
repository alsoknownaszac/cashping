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
 * Environment variables that hold a number but arrive as strings via
 * `process.env`, and therefore need coercing before validation.
 */
const NUMERIC_KEYS = ['PORT'] as const;

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

  // --- Error reporting (Sentry) --------------------------------------------
  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  SENTRY_DSN!: string;

  @IsOptional()
  SENTRY_ENVIRONMENT?: string;

  // --- AWS / KMS -----------------------------------------------------------
  @IsNotEmpty()
  AWS_REGION!: string;

  @IsNotEmpty()
  AWS_ACCESS_KEY_ID!: string;

  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY!: string;

  @IsNotEmpty()
  AWS_KMS_KEY_ID!: string;

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
