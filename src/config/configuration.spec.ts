import { afterEach, describe, expect, it } from 'vitest';
import configuration, {
  DEFAULT_CORS_ALLOWED_ORIGINS,
  DEFAULT_FALLBACK_HORIZON_URL,
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

  afterEach(() => {
    restore('CORS_ALLOWED_ORIGINS', originalValue);
    restore('ENABLE_SWAGGER', originalSwaggerValue);
    restore('STELLAR_HORIZON_FALLBACK_URL', originalFallbackValue);
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
});
