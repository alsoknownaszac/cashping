import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  Max,
  Min,
  validateSync,
  type ValidationError,
} from 'class-validator';

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

  // --- Database ------------------------------------------------------------
  @IsUrl({ protocols: ['postgresql', 'postgres'], require_tld: false })
  @IsNotEmpty()
  DATABASE_URL!: string;

  // --- Redis ---------------------------------------------------------------
  @IsUrl({ protocols: ['redis', 'rediss'], require_tld: false })
  @IsNotEmpty()
  REDIS_URL!: string;

  // --- Auth ----------------------------------------------------------------
  @IsNotEmpty()
  JWT_SECRET!: string;

  // --- Notifications (Africa's Talking) ------------------------------------
  @IsNotEmpty()
  AFRICASTALKING_API_KEY!: string;

  @IsOptional()
  AFRICASTALKING_USERNAME: string = 'sandbox';

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
  const lines = errors
    .flatMap((error) => describe(error))
    .map((message) => `  - ${message}`);

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
