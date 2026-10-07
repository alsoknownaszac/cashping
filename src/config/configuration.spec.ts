import { afterEach, describe, expect, it } from 'vitest';
import configuration, {
  DEFAULT_CORS_ALLOWED_ORIGINS,
  DEFAULT_FALLBACK_HORIZON_URL,
  DEFAULT_FRIENDBOT_URL,
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_PROVISIONING_TIMEOUT_MS,
  DEFAULT_SWAGGER_ENABLED,
} from './configuration.js';

/**
 * Only the values the factory does something *other* than pass through are
 * covered here: the CORS allow-list (split, trimmed, defaulted) and the
 * `ENABLE_SWAGGER` flag (parsed from a string, because `Boolean('false')` is
 * `true`). What a supplied value must look like is the validation schema's job
 * (`validation.schema.spec.ts`).
 *
 * Values are read from and written to the real `process.env` (never assumed to be
 * absent), and restored afterwards, so the result does not depend on the shell
 * that happens to run the tests.
 */
/** Puts a variable back exactly as the shell had it (or removes it entirely). */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('configuration', () => {
  const originalValue = process.env['CORS_ALLOWED_ORIGINS'];
  const originalSwaggerValue = process.env['ENABLE_SWAGGER'];
  const originalFallbackValue = process.env['STELLAR_HORIZON_FALLBACK_URL'];
  const originalFriendbotValue = process.env['STELLAR_FRIENDBOT_URL'];
  const originalTimeoutValue = process.env['STELLAR_PROVISIONING_TIMEOUT_MS'];

  afterEach(() => {
    restore('CORS_ALLOWED_ORIGINS', originalValue);
    restore('ENABLE_SWAGGER', originalSwaggerValue);
    restore('STELLAR_HORIZON_FALLBACK_URL', originalFallbackValue);
    restore('STELLAR_FRIENDBOT_URL', originalFriendbotValue);
    restore('STELLAR_PROVISIONING_TIMEOUT_MS', originalTimeoutValue);
  });

  describe('cors.allowedOrigins', () => {
    it('defaults to the two local frontend dev servers when the variable is unset', () => {
      delete process.env['CORS_ALLOWED_ORIGINS'];

      expect(configuration().cors.allowedOrigins).toEqual([...DEFAULT_CORS_ALLOWED_ORIGINS]);
    });

    it('splits the comma-separated value and trims each origin', () => {
      process.env['CORS_ALLOWED_ORIGINS'] = 'https://app.cashping.co, http://localhost:5173 ';

      expect(configuration().cors.allowedOrigins).toEqual([
        'https://app.cashping.co',
        'http://localhost:5173',
      ]);
    });

    it('never invents a wildcard, whatever the raw value is', () => {
      process.env['CORS_ALLOWED_ORIGINS'] = ', ,';

      expect(configuration().cors.allowedOrigins).toEqual([]);
    });

    it('re-reads the variable on every call, so a restart picks up a changed list', () => {
      process.env['CORS_ALLOWED_ORIGINS'] = 'http://localhost:4200';
      const first = configuration().cors.allowedOrigins;

      process.env['CORS_ALLOWED_ORIGINS'] = 'http://localhost:8000';
      const second = configuration().cors.allowedOrigins;

      expect(first).toEqual(['http://localhost:4200']);
      expect(second).toEqual(['http://localhost:8000']);
    });
  });

  describe('swagger.enabled', () => {
    it('is on by default, so local dev and the e2e suite keep their docs', () => {
      delete process.env['ENABLE_SWAGGER'];

      expect(DEFAULT_SWAGGER_ENABLED).toBe(true);
      expect(configuration().swagger.enabled).toBe(true);
    });

    // The reason this is not a pass-through: `Boolean('false')` is `true`, so a
    // naive cast would leave the docs published in production.
    it('reads the string "false" as false, not as a truthy string', () => {
      process.env['ENABLE_SWAGGER'] = 'false';

      expect(configuration().swagger.enabled).toBe(false);
    });

    it('accepts either literal in any case, with surrounding whitespace', () => {
      process.env['ENABLE_SWAGGER'] = ' TRUE ';
      expect(configuration().swagger.enabled).toBe(true);

      process.env['ENABLE_SWAGGER'] = 'False';
      expect(configuration().swagger.enabled).toBe(false);
    });

    it('falls back to the default for anything else, which the schema then rejects', () => {
      // Belt and braces with `validation.schema.ts`: an unrecognised value can
      // never reach a running app (validation aborts the boot), and if it somehow
      // did, it would not be read as "docs on by accident of spelling".
      process.env['ENABLE_SWAGGER'] = 'yes';

      expect(configuration().swagger.enabled).toBe(true);
    });
  });

  describe('stellar.fallbackHorizonUrl', () => {
    it('defaults to the local node Horizon when the variable is unset', () => {
      delete process.env['STELLAR_HORIZON_FALLBACK_URL'];

      expect(DEFAULT_FALLBACK_HORIZON_URL).toBe('http://localhost:8000');
      expect(configuration().stellar.fallbackHorizonUrl).toBe(DEFAULT_FALLBACK_HORIZON_URL);
    });

    it('takes a supplied host and strips the trailing slash', () => {
      // This value is concatenated into request URLs downstream, so a trailing
      // slash would become a double slash at the worst possible moment.
      process.env['STELLAR_HORIZON_FALLBACK_URL'] = ' https://horizon.internal.cashping.co/ ';

      expect(configuration().stellar.fallbackHorizonUrl).toBe(
        'https://horizon.internal.cashping.co',
      );
    });

    it('reads an empty value as unset, which the schema refuses separately', () => {
      // Same split as ENABLE_SWAGGER: the factory always produces something usable,
      // and `validation.schema.ts` is the half that stops the boot. Belt and braces,
      // because a blank optional variable is what `VAR=` in an .env file produces.
      process.env['STELLAR_HORIZON_FALLBACK_URL'] = '';

      expect(configuration().stellar.fallbackHorizonUrl).toBe(DEFAULT_FALLBACK_HORIZON_URL);
    });

    it('leaves the primary Horizon url alone', () => {
      process.env['STELLAR_HORIZON_FALLBACK_URL'] = 'https://horizon.internal.cashping.co';

      expect(configuration().stellar.horizonUrl).toBe(process.env['STELLAR_HORIZON_URL']);
      expect(configuration().stellar.fallbackHorizonUrl).toBe(
        'https://horizon.internal.cashping.co',
      );
    });
  });

  describe('stellar.friendbotUrl', () => {
    it('defaults to the public Testnet faucet when the variable is unset', () => {
      delete process.env['STELLAR_FRIENDBOT_URL'];

      expect(DEFAULT_FRIENDBOT_URL).toBe('https://friendbot.stellar.org/');
      expect(configuration().stellar.friendbotUrl).toBe(DEFAULT_FRIENDBOT_URL);
    });

    it('takes a supplied endpoint unchanged', () => {
      // Deliberately *not* trimmed of its trailing slash, unlike the Horizon fallback:
      // the funder parses this with `URL` rather than concatenating it, and `new URL`
      // reads `https://host` and `https://host/` as the same address. The path form is
      // what Horizon itself serves the faucet on, so it has to survive intact.
      process.env['STELLAR_FRIENDBOT_URL'] = ' https://horizon-testnet.stellar.org/friendbot';

      expect(configuration().stellar.friendbotUrl).toBe(
        'https://horizon-testnet.stellar.org/friendbot',
      );
    });

    it('reads an empty value as unset, which the schema refuses separately', () => {
      process.env['STELLAR_FRIENDBOT_URL'] = '';

      expect(configuration().stellar.friendbotUrl).toBe(DEFAULT_FRIENDBOT_URL);
    });
  });

  describe('stellar.provisioningTimeoutMs', () => {
    it('defaults to 30 seconds when the variable is unset', () => {
      delete process.env['STELLAR_PROVISIONING_TIMEOUT_MS'];

      expect(DEFAULT_PROVISIONING_TIMEOUT_MS).toBe(30_000);
      expect(configuration().stellar.provisioningTimeoutMs).toBe(DEFAULT_PROVISIONING_TIMEOUT_MS);
    });

    it('reads a supplied value as a number, because the schema coerces it', () => {
      // The value reaches this factory already coerced by `validation.schema.ts`
      // (`NUMERIC_KEYS`); reading it with `Number()` here is what keeps the factory
      // correct when it is called directly, in a spec like this one.
      process.env['STELLAR_PROVISIONING_TIMEOUT_MS'] = '45000';

      expect(configuration().stellar.provisioningTimeoutMs).toBe(45_000);
    });
  });

  describe('aws.endpointUrl', () => {
    const originalEndpointValue = process.env['AWS_ENDPOINT_URL'];

    afterEach(() => {
      restore('AWS_ENDPOINT_URL', originalEndpointValue);
    });

    // Pass-through, but asserted anyway: the default is the whole point. There must be no
    // fallback endpoint, because a fallback would mean custody silently pointing somewhere
    // other than AWS the moment the variable was mistyped into existence.
    it('is undefined unless AWS_ENDPOINT_URL is set, so the SDK uses the regional AWS endpoint', () => {
      delete process.env['AWS_ENDPOINT_URL'];

      expect(configuration().aws.endpointUrl).toBeUndefined();
    });

    it('takes a supplied endpoint as it is', () => {
      process.env['AWS_ENDPOINT_URL'] = 'http://localhost:4566';

      expect(configuration().aws.endpointUrl).toBe('http://localhost:4566');
    });
  });

  describe('http.jsonBodyLimit', () => {
    const originalBodyLimit = process.env['BODY_LIMIT_JSON'];

    afterEach(() => {
      restore('BODY_LIMIT_JSON', originalBodyLimit);
    });

    it('defaults to the 16kb ceiling when the variable is unset', () => {
      delete process.env['BODY_LIMIT_JSON'];

      expect(DEFAULT_JSON_BODY_LIMIT).toBe('16kb');
      expect(configuration().http.jsonBodyLimit).toBe(DEFAULT_JSON_BODY_LIMIT);
    });

    it('takes a supplied size verbatim, because body-parser parses the unit itself', () => {
      process.env['BODY_LIMIT_JSON'] = '1mb';

      expect(configuration().http.jsonBodyLimit).toBe('1mb');
    });

    // A blank value is what `BODY_LIMIT_JSON=` in an `.env` file produces - the same
    // belt-and-braces split as the other resolvers above: the factory always yields something
    // usable, and `validation.schema.ts` is the half that stops the boot.
    it('reads an empty value as unset', () => {
      process.env['BODY_LIMIT_JSON'] = '   ';

      expect(configuration().http.jsonBodyLimit).toBe(DEFAULT_JSON_BODY_LIMIT);
    });
  });
});
