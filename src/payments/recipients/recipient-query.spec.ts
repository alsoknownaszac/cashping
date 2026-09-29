import { describe, expect, it } from 'vitest';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from '../../identity/handle/handle.js';
import {
  RECIPIENT_SEARCH_DEFAULT_LIMIT,
  RECIPIENT_SEARCH_MAX_LIMIT,
  UnsearchableQueryError,
  classifyRecipientQuery,
  unsearchableQueryMessage,
  type UnsearchableQueryReason,
} from './recipient-query.js';

/**
 * Step 21's classification, as the pure function it is: this file is the whole contract the
 * search endpoint has with `q`, decided before any query runs - which is why it needs no
 * database, no Redis and no Nest, only the Step 9 normalizer and the Step 15 handle rules it
 * delegates to.
 *
 * Each group below is a product decision rather than an implementation detail:
 *
 * 1. Every spelling of a number reaches one E.164 string, so a caller never has to know which
 *    format the database holds.
 * 2. A number is never read as a prefix. `+2332412345` is not a search for every registered
 *    number that starts with those digits - that is the sweep the rate limit is there to price,
 *    and a prefix match would answer it in one request.
 * 3. A value that is not a number is a handle search, not an error, and the handle rules are
 *    the registration rules - with the one exception asserted below: a reserved word is
 *    searchable, because looking for `admin` is a reasonable way to find nobody.
 */

const REGION = 'GH';

/** `+233241234567`, the number every spelling below means. */
const GH_E164 = '+233241234567';

/** The spellings a person types - `phone-number.spec.ts`'s table, which this must not drift from. */
const GH_INPUTS: ReadonlyArray<string> = [
  '0241234567',
  '024 123 4567',
  '024-123-4567',
  '(024) 1234567',
  '+233241234567',
  '+233 24 123 4567',
  '233241234567',
  '00233241234567',
  '  +233 241 234 567  ',
];

/** The refusal `reason` for an input, or a failure if it was accepted. */
function reasonFor(input: string): UnsearchableQueryReason {
  try {
    classifyRecipientQuery(input, REGION);
  } catch (error) {
    if (error instanceof UnsearchableQueryError) {
      return error.reason;
    }

    throw error;
  }

  throw new Error(`expected ${JSON.stringify(input)} to be refused`);
}

describe('classifyRecipientQuery', () => {
  describe('phone numbers, matched exactly', () => {
    for (const input of GH_INPUTS) {
      it(`reads ${JSON.stringify(input)} as ${GH_E164}`, () => {
        expect(classifyRecipientQuery(input, REGION)).toEqual({
          kind: 'phone',
          phoneNumber: GH_E164,
        });
      });
    }

    it('collapses every spelling onto one query, which is what makes the match exact', () => {
      const queries = new Set(
        GH_INPUTS.map((input) => JSON.stringify(classifyRecipientQuery(input, REGION))),
      );

      expect(queries.size).toBe(1);
    });

    it('never classifies a partial number as a phone query', () => {
      // A number typed with digits missing is a *handle* of digits, not a prefix match on
      // `phone_number`: the reading that would answer "who is in this range" - one request
      // instead of a sweep - does not exist, and this is the assertion that keeps it gone.
      expect(classifyRecipientQuery('02412345', REGION)).toEqual({
        kind: 'handle',
        prefix: '02412345',
      });
    });

    it('consults the default region for a local spelling, as registration does', () => {
      expect(classifyRecipientQuery('08031234567', 'NG')).toEqual({
        kind: 'phone',
        phoneNumber: '+2348031234567',
      });
    });
  });

  describe('handles, matched by prefix', () => {
    it('reads a bare handle as a prefix, in the canonical lower case the column holds', () => {
      expect(classifyRecipientQuery('mir', REGION)).toEqual({ kind: 'handle', prefix: 'mir' });
    });

    it('accepts the @ the product writes handles with', () => {
      // The prefix is the *normalized* form, which is the form the column stores: the query
      // compares against canonical handles, so it never needs a case-insensitive mode.
      expect(classifyRecipientQuery('@Miriam_Owusu', REGION)).toEqual({
        kind: 'handle',
        prefix: 'miriam_owusu',
      });
    });

    it('trims the whitespace a person leaves behind', () => {
      expect(classifyRecipientQuery('  mir  ', REGION)).toEqual({ kind: 'handle', prefix: 'mir' });
    });

    it('reads a reserved word as a search rather than a refusal', () => {
      // `handleProblem` answers "may this become someone's handle", which is policy about
      // *registration*: nobody can hold `admin`. Searching for it is a different question whose
      // answer is a list of nobody - see `UnsearchableQueryReason`, which excludes `reserved`.
      expect(classifyRecipientQuery('admin', REGION)).toEqual({ kind: 'handle', prefix: 'admin' });
    });

    it('accepts the shortest and the longest handle the registration rules allow', () => {
      const shortest = 'a'.repeat(HANDLE_MIN_LENGTH);
      const longest = 'a'.repeat(HANDLE_MAX_LENGTH);

      expect(classifyRecipientQuery(shortest, REGION)).toEqual({
        kind: 'handle',
        prefix: shortest,
      });
      expect(classifyRecipientQuery(longest, REGION)).toEqual({
        kind: 'handle',
        prefix: longest,
      });
    });
  });

  describe('what it refuses, and why', () => {
    it('refuses an empty or blank query as `empty`', () => {
      expect(reasonFor('')).toBe('empty');
      expect(reasonFor('   ')).toBe('empty');
    });

    it('refuses a handle below the minimum length', () => {
      expect(reasonFor('@a')).toBe('too_short');
    });

    it('refuses a handle above the maximum length', () => {
      expect(reasonFor('a'.repeat(HANDLE_MAX_LENGTH + 1))).toBe('too_long');
    });

    it('refuses characters a handle may not contain', () => {
      // Including a partial number that kept its `+`: the normalizer rejected it and `+` is not
      // a handle character, so this is a refusal rather than a search that finds nothing.
      expect(reasonFor('miriam owusu')).toBe('characters');
      expect(reasonFor('+2332412345')).toBe('characters');
      expect(reasonFor('@miriam@example.com')).toBe('characters');
    });

    it('names the refused input, so the 400 can show which field was wrong', () => {
      const error = (() => {
        try {
          classifyRecipientQuery('ab', REGION);
          return undefined;
        } catch (caught) {
          return caught as UnsearchableQueryError;
        }
      })();

      expect(error?.input).toBe('ab');
      expect(error?.message).toContain('ab');
    });
  });
});

describe('unsearchableQueryMessage', () => {
  /** Every reason `classifyRecipientQuery` can refuse with, listed so the list cannot rot. */
  const REASONS: ReadonlyArray<UnsearchableQueryReason> = [
    'empty',
    'too_short',
    'too_long',
    'characters',
  ];

  it('has a finished sentence for every reason', () => {
    for (const reason of REASONS) {
      const message = unsearchableQueryMessage(reason);

      expect(message.endsWith('.'), `${reason} should read as a sentence`).toBe(true);
      expect(message, `${reason} should not leak an internal name`).not.toMatch(
        /undefined|reason|_/,
      );
    }
  });

  it('names the rule in the numbers it broke, rather than saying "invalid search"', () => {
    // The two reasons a person actually hits are ordinary mistakes: a handle typed one character
    // short, and one typed one character long. Both are fixable in place *if* the message says so.
    expect(unsearchableQueryMessage('too_short')).toContain(String(HANDLE_MIN_LENGTH));
    expect(unsearchableQueryMessage('too_long')).toContain(String(HANDLE_MAX_LENGTH));
  });
});

describe('the search limits', () => {
  it('caps a result set far below an address-book export', () => {
    // `q=a&limit=100000` returning every handle containing an `a` is what this ceiling is for:
    // twenty candidates is already more than a person reads, and a sweep of the namespace has to
    // be many requests - which is what the rate limiter counts.
    expect(RECIPIENT_SEARCH_DEFAULT_LIMIT).toBeLessThanOrEqual(RECIPIENT_SEARCH_MAX_LIMIT);
    expect(RECIPIENT_SEARCH_MAX_LIMIT).toBe(20);
  });
});
