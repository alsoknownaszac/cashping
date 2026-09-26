import { describe, expect, it } from 'vitest';
import {
  EnvironmentVariables,
  NodeEnvironment,
  StellarNetwork,
  validate,
} from './validation.schema.js';

/**
 * A complete, valid environment mirroring `.env.example`. Every spec passes an
 * explicit object rather than reading `process.env`, so results never depend on
 * whatever happens to be exported in the shell running the tests.
 */
const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://cashping:cashping@localhost:5432/cashping?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-long-random-secret',
  AFRICASTALKING_API_KEY: 'atsk_test_000000000000',
  AFRICASTALKING_USERNAME: 'sandbox',
  SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0',
  SENTRY_ENVIRONMENT: 'development',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  STELLAR_NETWORK: 'TESTNET',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
};

/** Every variable the schema marks as required (i.e. not `@IsOptional()`). */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'AFRICASTALKING_API_KEY',
  'SENTRY_DSN',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_KMS_KEY_ID',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
] as const;

/** Runs `fn` and returns the error it threw; fails the test if it did not throw. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (caught) {
    return caught as Error;
  }

  throw new Error('expected the callback to throw, but it did not');
}

describe('environment validation', () => {
  it('accepts a complete environment and coerces PORT to a number', () => {
    const result = validate({ ...VALID_ENV });

    expect(result).toBeInstanceOf(EnvironmentVariables);
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
    expect(result.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(result.STELLAR_NETWORK).toBe(StellarNetwork.Testnet);
    expect(result.DATABASE_URL).toBe(VALID_ENV['DATABASE_URL']);
  });

  it('falls back to defaults for optional variables', () => {
    const withoutOptional = { ...VALID_ENV };
    delete withoutOptional['NODE_ENV'];
    delete withoutOptional['PORT'];
    delete withoutOptional['AFRICASTALKING_USERNAME'];

    const result = validate(withoutOptional);

    expect(result.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(result.PORT).toBe(3000);
    expect(result.AFRICASTALKING_USERNAME).toBe('sandbox');
  });

  // Audit checklist Step 4: removing a required variable must produce a clear,
  // specific boot-time error naming the variable - not a silent default and not
  // a runtime crash several requests in.
  for (const key of REQUIRED_KEYS) {
    it(`rejects a missing ${key}, naming it and saying it is empty`, () => {
      const incomplete = { ...VALID_ENV };
      delete incomplete[key];

      // Exact phrasing matters: the operator must be told the variable is
      // missing, not that some unrelated constraint on it failed.
      expect(() => validate(incomplete)).toThrowError(
        new RegExp(`${key} should not be empty`),
      );
    });
  }

  it('reports every missing variable at once, not just the first', () => {
    const incomplete = { ...VALID_ENV };
    delete incomplete['DATABASE_URL'];
    delete incomplete['JWT_SECRET'];

    const error = captureError(() => validate(incomplete));

    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('JWT_SECRET');
  });

  it('reports one message per variable, not one per failed constraint', () => {
    const incomplete = { ...VALID_ENV };
    delete incomplete['DATABASE_URL'];

    const error = captureError(() => validate(incomplete));
    const mentions = error.message
      .split('\n')
      .filter((line) => line.includes('DATABASE_URL'));

    expect(mentions).toHaveLength(1);
  });

  it('rejects a non-numeric PORT instead of silently defaulting it', () => {
    expect(() => validate({ ...VALID_ENV, PORT: 'not-a-port' })).toThrowError(/PORT/);
  });

  it('rejects an unknown STELLAR_NETWORK', () => {
    expect(() => validate({ ...VALID_ENV, STELLAR_NETWORK: 'MAINNET' })).toThrowError(
      /STELLAR_NETWORK/,
    );
  });

  it('rejects a DATABASE_URL that is not a Postgres URL', () => {
    expect(() => validate({ ...VALID_ENV, DATABASE_URL: 'mysql://localhost/db' })).toThrowError(
      /DATABASE_URL/,
    );
  });
});
