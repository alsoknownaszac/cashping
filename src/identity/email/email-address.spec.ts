import { describe, expect, it } from 'vitest';
import {
  InvalidEmailAddressError,
  MAX_EMAIL_LENGTH,
  normalizeEmailAddress,
} from './email-address.js';

/**
 * The email address rule, asserted directly (Step 34c) because two callers depend on
 * agreeing about it: `AuthService` normalizes before a write, and `EmailService` stores the
 * result - so the *stored* value is this function's output, and a drift between the two would
 * be a row that `AuthService` looked up differently from how it was written.
 */

describe('normalizeEmailAddress', () => {
  it('lower-cases and trims, so one mailbox is one value', () => {
    // The point of the rule: `Miriam@Example.com` and `miriam@example.com` are one address, and
    // the unique index on `users.email` has to see them as one row rather than two.
    expect(normalizeEmailAddress('  Miriam@Example.com  ')).toBe('miriam@example.com');
    expect(normalizeEmailAddress('MIRIAM@EXAMPLE.COM')).toBe('miriam@example.com');
  });

  it('accepts an ordinary address unchanged apart from case', () => {
    expect(normalizeEmailAddress('miriam.owusu+tag@example.co.uk')).toBe(
      'miriam.owusu+tag@example.co.uk',
    );
  });

  it('refuses the shapes a person can actually mistype', () => {
    for (const input of [
      'miriam', // no @
      'miriam@', // no domain
      '@example.com', // no local part
      'miriam@example', // no dot in the domain
      'mir@iam@example.com', // two @
      'miriam @example.com', // a space
      'miriam@exa mple.com', // a space in the domain
      '',
      '   ', // whitespace only
    ]) {
      expect(() => normalizeEmailAddress(input), `"${input}" should be refused`).toThrow(
        InvalidEmailAddressError,
      );
    }
  });

  it('names the rule it broke, so the 400 can say something useful', () => {
    try {
      normalizeEmailAddress('nope');
      expect.unreachable('an invalid address should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEmailAddressError);
      expect((error as InvalidEmailAddressError).problem).toBe('shape');
      // The raw input is echoed, not the normalized one: it is the caller's own value, and the
      // one thing they can compare against what they meant to type.
      expect((error as InvalidEmailAddressError).input).toBe('nope');
    }
  });

  it('refuses an address longer than the ceiling, and accepts one on it', () => {
    const domain = '@example.com';
    const localAtCeiling = 'a'.repeat(MAX_EMAIL_LENGTH - domain.length);

    expect(normalizeEmailAddress(`${localAtCeiling}${domain}`)).toHaveLength(MAX_EMAIL_LENGTH);

    expect(() => normalizeEmailAddress(`${localAtCeiling}a${domain}`)).toThrow(
      InvalidEmailAddressError,
    );
  });
});
