import { describe, expect, it } from 'vitest';
import { InvalidPhoneNumberError, normalizePhoneNumber } from './phone-number.js';

/**
 * Step 9's whole point: every reasonable way a person writes their number has to
 * arrive at the database as one string. The table below is the contract - the
 * audit checklist asks for at least five distinct input formats collapsing to
 * the same E.164 output, and this covers Ghana (the default region) plus Nigeria
 * to prove the region is genuinely consulted rather than assumed.
 */

/** `+233241234567` - the Ghanaian number every variant below means. */
const GH_E164 = '+233241234567';

const GH_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['local, leading zero', '0241234567'],
  ['local, spaced', '024 123 4567'],
  ['local, hyphenated', '024-123-4567'],
  ['local, in parentheses', '(024) 1234567'],
  ['international, plus', '+233241234567'],
  ['international, plus with national prefix', '+2330241234567'],
  ['international, spaced', '+233 24 123 4567'],
  ['international, no plus', '233241234567'],
  ['international, no plus with national prefix', '2330241234567'],
  ['international, 00 prefix', '00233241234567'],
  ['padded with whitespace', '  +233 241 234 567  '],
];

describe('normalizePhoneNumber', () => {
  describe('Ghanaian numbers', () => {
    for (const [description, input] of GH_INPUTS) {
      it(`normalizes ${description} (${JSON.stringify(input)}) to ${GH_E164}`, () => {
        expect(normalizePhoneNumber(input, 'GH')).toBe(GH_E164);
      });
    }

    it('collapses every variant onto exactly one string, which is what the unique index needs', () => {
      const normalized = new Set(GH_INPUTS.map(([, input]) => normalizePhoneNumber(input, 'GH')));

      expect(normalized.size).toBe(1);
    });
  });

  describe('the default region decides how a local number is read', () => {
    it('reads a Nigerian local number as Nigerian when that is the default region', () => {
      expect(normalizePhoneNumber('08031234567', 'NG')).toBe('+2348031234567');
    });

    it('does not reinterpret a number that carries its own country code', () => {
      // The region is a default, not an override: +234... is Nigerian whatever
      // the API is configured for, so a diaspora user is not sent an SMS to
      // somebody else's country.
      expect(normalizePhoneNumber('+2348031234567', 'GH')).toBe('+2348031234567');
      expect(normalizePhoneNumber('+14155552671', 'GH')).toBe('+14155552671');
    });
  });

  describe('rejects what it cannot normalize', () => {
    // Malformed input is a Days 6-7 edge case that has to be handled at the door:
    // a wrong number under a unique index is a duplicate account, and a texted OTP
    // is somebody else's money.
    const INVALID: ReadonlyArray<readonly [string, string]> = [
      ['letters', 'not-a-number'],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a truncated number', '02412345'],
      ['a local number with too many digits', '02412345678901'],
      ['the bare country code', '+233'],
      ['a plus sign with nothing after it', '+'],
      ['an unassigned country code', '+999123456789'],
    ];

    for (const [description, input] of INVALID) {
      it(`throws InvalidPhoneNumberError for ${description} (${JSON.stringify(input)})`, () => {
        expect(() => normalizePhoneNumber(input, 'GH')).toThrowError(InvalidPhoneNumberError);
      });
    }

    it('names the offending input in the error, so the caller can say what was rejected', () => {
      const error = (() => {
        try {
          normalizePhoneNumber('not-a-number', 'GH');
          return undefined;
        } catch (caught) {
          return caught as InvalidPhoneNumberError;
        }
      })();

      expect(error?.input).toBe('not-a-number');
      expect(error?.message).toContain('not-a-number');
    });
  });
});
