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
  JWT_SECRET: 'not-a-real-secret-just-a-test-fixture-value',
  AFRICASTALKING_API_KEY: 'atsk_test_000000000000',
  AFRICASTALKING_USERNAME: 'sandbox',
  RESEND_API_KEY: 're_test_000000000000',
  SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0',
  SENTRY_ENVIRONMENT: 'development',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  STELLAR_NETWORK: 'TESTNET',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

/** Every variable the schema marks as required (i.e. not `@IsOptional()`). */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'AFRICASTALKING_API_KEY',
  'RESEND_API_KEY',
  'SENTRY_DSN',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_KMS_KEY_ID',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'STELLAR_USDC_ISSUER',
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
      expect(() => validate(incomplete)).toThrowError(new RegExp(`${key} should not be empty`));
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
    const mentions = error.message.split('\n').filter((line) => line.includes('DATABASE_URL'));

    expect(mentions).toHaveLength(1);
  });

  it('rejects a non-numeric PORT instead of silently defaulting it', () => {
    expect(() => validate({ ...VALID_ENV, PORT: 'not-a-port' })).toThrowError(/PORT/);
  });

  // --- Interactive docs (Swagger UI) ---------------------------------------

  it('defaults ENABLE_SWAGGER to true when unset', () => {
    const withoutFlag = { ...VALID_ENV };
    delete withoutFlag['ENABLE_SWAGGER'];

    expect(validate(withoutFlag).ENABLE_SWAGGER).toBe(true);
  });

  // `process.env` only holds strings, so both literals have to survive the
  // journey as booleans - `Boolean('false')` is `true`, which would silently
  // leave the docs published in production.
  const BOOLEAN_LITERALS: ReadonlyArray<readonly [string, boolean]> = [
    ['true', true],
    ['false', false],
    [' FALSE ', false],
  ];

  for (const [value, expected] of BOOLEAN_LITERALS) {
    it(`coerces ENABLE_SWAGGER=${JSON.stringify(value)} to ${expected}`, () => {
      expect(validate({ ...VALID_ENV, ENABLE_SWAGGER: value }).ENABLE_SWAGGER).toBe(expected);
    });
  }

  for (const value of ['yes', '1', 'flase', '']) {
    it(`rejects ENABLE_SWAGGER=${JSON.stringify(value)}, naming the variable`, () => {
      expect(() => validate({ ...VALID_ENV, ENABLE_SWAGGER: value })).toThrowError(
        /ENABLE_SWAGGER/,
      );
    });
  }

  it('rejects an unknown STELLAR_NETWORK', () => {
    expect(() => validate({ ...VALID_ENV, STELLAR_NETWORK: 'MAINNET' })).toThrowError(
      /STELLAR_NETWORK/,
    );
  });

  // --- Stellar Horizon fallback (Step 17) ----------------------------------

  it('accepts a STELLAR_HORIZON_FALLBACK_URL that is a URL', () => {
    const fallback = 'https://horizon.internal.cashping.co';

    expect(validate({ ...VALID_ENV, STELLAR_HORIZON_FALLBACK_URL: fallback })).toMatchObject({
      STELLAR_HORIZON_FALLBACK_URL: fallback,
    });
  });

  it('leaves STELLAR_HORIZON_FALLBACK_URL undefined when unset, so the factory default applies', () => {
    expect(validate({ ...VALID_ENV }).STELLAR_HORIZON_FALLBACK_URL).toBeUndefined();
  });

  // An optional variable that is *present but empty* is what `VAR=` in an .env
  // file produces. The factory would paper over it with the local-node default, so
  // the schema is the half that names it - the same belt-and-braces split as
  // ENABLE_SWAGGER. The scheme-less value is here because the SDK parses this into
  // a `URL`: it would boot and then fail at the first account load.
  for (const value of ['', '   ', 'horizon-testnet.stellar.org']) {
    it(`rejects STELLAR_HORIZON_FALLBACK_URL=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, STELLAR_HORIZON_FALLBACK_URL: value })).toThrowError(
        /STELLAR_HORIZON_FALLBACK_URL/,
      );
    });
  }

  // --- Stellar provisioning (Step 19) --------------------------------------

  it('accepts a Stellar account address as STELLAR_USDC_ISSUER', () => {
    expect(validate({ ...VALID_ENV }).STELLAR_USDC_ISSUER).toBe(VALID_ENV['STELLAR_USDC_ISSUER']);
  });

  // The mistakes that reach a config file in practice, and none of them is cosmetic:
  // the `S...` *secret* key the same dashboard shows next to the public one (an issuer
  // that is a secret is a key leak in a log, and the asset still cannot be trusted), a
  // truncated paste, a lowercase one (Stellar addresses are uppercase base32, and nothing
  // downstream accepts the lowercase spelling, so accepting it here would only postpone
  // the failure to the first trustline build), and a bare code - the other half of the
  // asset pair, which is never the issuer.
  for (const value of [
    '',
    '   ',
    'SBBR47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA',
    'gbbd47if6lwk7p7mdevscwr7dpuwv3ny3dtqevfl4nat4aqh3zllfla5',
    'USDC',
  ]) {
    it(`rejects STELLAR_USDC_ISSUER=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, STELLAR_USDC_ISSUER: value })).toThrowError(
        /STELLAR_USDC_ISSUER/,
      );
    });
  }

  // Horizon serves the same faucet on a path, which is the other spelling worth
  // supporting - see `FriendbotFunder`.
  it('accepts a STELLAR_FRIENDBOT_URL that is a URL', () => {
    const funder = 'https://horizon-testnet.stellar.org/friendbot';

    expect(validate({ ...VALID_ENV, STELLAR_FRIENDBOT_URL: funder })).toMatchObject({
      STELLAR_FRIENDBOT_URL: funder,
    });
  });

  it('leaves STELLAR_FRIENDBOT_URL undefined when unset, so the Testnet faucet default applies', () => {
    expect(validate({ ...VALID_ENV }).STELLAR_FRIENDBOT_URL).toBeUndefined();
  });

  // Blank is what `VAR=` in an .env file produces, and the scheme-less value is a copied
  // hostname: the funder parses this into a `URL` on every request, so both would boot and
  // then fail at the first account - the least useful place to find out a scheme is
  // missing. Same split as STELLAR_HORIZON_FALLBACK_URL.
  for (const value of ['', '   ', 'friendbot.stellar.org']) {
    it(`rejects STELLAR_FRIENDBOT_URL=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, STELLAR_FRIENDBOT_URL: value })).toThrowError(
        /STELLAR_FRIENDBOT_URL/,
      );
    });
  }

  it('coerces STELLAR_PROVISIONING_TIMEOUT_MS to a number', () => {
    const result = validate({ ...VALID_ENV, STELLAR_PROVISIONING_TIMEOUT_MS: '45000' });

    expect(result.STELLAR_PROVISIONING_TIMEOUT_MS).toBe(45_000);
    expect(typeof result.STELLAR_PROVISIONING_TIMEOUT_MS).toBe('number');
  });

  it('leaves STELLAR_PROVISIONING_TIMEOUT_MS undefined when unset, so the factory default applies', () => {
    expect(validate({ ...VALID_ENV }).STELLAR_PROVISIONING_TIMEOUT_MS).toBeUndefined();
  });

  // Zero is the one that matters most: it reads like a working timeout and behaves like a
  // disabled one, which is why the lower bound is one millisecond rather than zero. The
  // upper bound is the point at which waiting is no longer a strategy.
  for (const value of ['', '   ', 'soon', '30000.5', '0', '-1', '700000']) {
    it(`rejects STELLAR_PROVISIONING_TIMEOUT_MS=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, STELLAR_PROVISIONING_TIMEOUT_MS: value })).toThrowError(
        /STELLAR_PROVISIONING_TIMEOUT_MS/,
      );
    });
  }

  it('rejects a DATABASE_URL that is not a Postgres URL', () => {
    expect(() => validate({ ...VALID_ENV, DATABASE_URL: 'mysql://localhost/db' })).toThrowError(
      /DATABASE_URL/,
    );
  });

  // --- Phone numbers -------------------------------------------------------

  // `PHONE_DEFAULT_REGION` is what makes a national-format number like
  // `024 123 4567` parseable, so a value libphonenumber has no metadata for is a
  // boot-time failure rather than a surprise at the registration endpoint.
  it('accepts a supported PHONE_DEFAULT_REGION, in any case', () => {
    expect(validate({ ...VALID_ENV, PHONE_DEFAULT_REGION: 'gh' }).PHONE_DEFAULT_REGION).toBe('gh');
  });

  it('leaves PHONE_DEFAULT_REGION undefined when unset, so the factory default (GH) applies', () => {
    expect(validate({ ...VALID_ENV }).PHONE_DEFAULT_REGION).toBeUndefined();
  });

  // The shape of a country code is not the test: `XX` is two letters and would
  // pass a regex, then hand the parser a region it has nothing for.
  for (const value of ['XX', 'ZZ', 'Ghana', 'G', '1', '']) {
    it(`rejects PHONE_DEFAULT_REGION=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, PHONE_DEFAULT_REGION: value })).toThrowError(
        /PHONE_DEFAULT_REGION/,
      );
    });
  }

  // --- CORS ----------------------------------------------------------------

  it('accepts a comma-separated CORS_ALLOWED_ORIGINS list', () => {
    const origins = 'http://localhost:3000, https://app.cashping.co';
    const result = validate({ ...VALID_ENV, CORS_ALLOWED_ORIGINS: origins });

    expect(result.CORS_ALLOWED_ORIGINS).toBe(origins);
  });

  it('leaves CORS_ALLOWED_ORIGINS undefined when unset, so the factory default applies', () => {
    expect(validate({ ...VALID_ENV }).CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  // The CORS middleware compares these entries literally against the `Origin`
  // header a browser sends, so a value a browser never sends has to fail at boot
  // rather than turn into an opaque CORS error in the frontend's console.
  const INVALID_CORS_VALUES: ReadonlyArray<readonly [string, string]> = [
    ['a trailing slash', 'http://localhost:5173/'],
    ['a missing scheme', 'localhost:5173'],
    ['a path', 'http://localhost:5173/app'],
    ['a wildcard', '*'],
    ['a wildcard host', 'https://*.cashping.co'],
    ['an empty value', ''],
    ['an empty entry', 'http://localhost:3000,'],
  ];

  for (const [description, value] of INVALID_CORS_VALUES) {
    it(`rejects CORS_ALLOWED_ORIGINS with ${description}`, () => {
      expect(() => validate({ ...VALID_ENV, CORS_ALLOWED_ORIGINS: value })).toThrowError(
        /CORS_ALLOWED_ORIGINS must be a comma-separated list of origins/,
      );
    });
  }

  // --- AWS / KMS (Step 18) -------------------------------------------------

  // The key reference decides what every account's seed is encrypted under, and these are
  // the three forms AWS accepts - so all three have to pass, because any of them can come
  // from a real deployment.
  it('accepts a KMS key ARN, a bare key id and an alias', () => {
    const forms = [
      'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
      '1234abcd-12ab-34cd-56ef-1234567890ab',
      'alias/cashping-seeds',
    ];

    for (const value of forms) {
      expect(validate({ ...VALID_ENV, AWS_KMS_KEY_ID: value }).AWS_KMS_KEY_ID).toBe(value);
    }
  });

  // `replace-me` and `local-compose-placeholder` are the placeholders that used to be in
  // .env.example and docker-compose.yml. Either would have booted and then failed on the
  // first registration, which is exactly what this constraint exists to stop - custody has
  // no working default.
  for (const value of ['replace-me', 'local-compose-placeholder', 'not-a-key', '', 'key/1234']) {
    it(`rejects AWS_KMS_KEY_ID=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, AWS_KMS_KEY_ID: value })).toThrowError(
        /AWS_KMS_KEY_ID/,
      );
    });
  }

  // A blank or malformed region is not a small mistake: the SDK would fall back to a region
  // of its own, and a key in another region comes back as `NotFoundException`, which reads
  // like a deleted key rather than a region mismatch.
  for (const value of ['', 'eu_west_1', 'europe', 'eu-west', 'EU-WEST-1']) {
    it(`rejects AWS_REGION=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, AWS_REGION: value })).toThrowError(/AWS_REGION/);
    });
  }

  it('accepts the region forms AWS uses', () => {
    for (const value of ['eu-west-1', 'us-east-1', 'ap-southeast-2', 'us-gov-west-1']) {
      expect(validate({ ...VALID_ENV, AWS_REGION: value }).AWS_REGION).toBe(value);
    }
  });

  it('leaves AWS_ENDPOINT_URL undefined when unset, so the SDK uses the regional endpoint', () => {
    expect(validate({ ...VALID_ENV }).AWS_ENDPOINT_URL).toBeUndefined();
  });

  it('accepts AWS_ENDPOINT_URL outside production', () => {
    const result = validate({ ...VALID_ENV, AWS_ENDPOINT_URL: 'http://localhost:4566' });

    expect(result.AWS_ENDPOINT_URL).toBe('http://localhost:4566');
  });

  // A bare host would boot and then fail at the first KMS call, because the SDK parses this
  // into a URL - the same constraint as STELLAR_HORIZON_FALLBACK_URL, for the same reason.
  for (const value of ['', '   ', 'localhost:4566']) {
    it(`rejects AWS_ENDPOINT_URL=${JSON.stringify(value)}`, () => {
      expect(() => validate({ ...VALID_ENV, AWS_ENDPOINT_URL: value })).toThrowError(
        /AWS_ENDPOINT_URL/,
      );
    });
  }

  // The cross-variable rule, and the one that matters most: custody pointed at an endpoint
  // that is not AWS, while AWS_KMS_KEY_ID still names an AWS key, is a different trust
  // boundary rather than a convenience - so it is refused, not logged.
  it('refuses AWS_ENDPOINT_URL in production', () => {
    expect(() =>
      validate({
        ...VALID_ENV,
        NODE_ENV: 'production',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
      }),
    ).toThrowError(/AWS_ENDPOINT_URL is set while NODE_ENV=production/);
  });

  it('leaves production alone once the endpoint is removed', () => {
    expect(validate({ ...VALID_ENV, NODE_ENV: 'production' }).NODE_ENV).toBe(
      NodeEnvironment.Production,
    );
  });
});
