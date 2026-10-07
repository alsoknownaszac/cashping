import { describe, expect, it } from 'vitest';
import {
  DEPOSITS_DEFAULT_LIMIT,
  DEPOSITS_MAX_LIMIT,
  InvalidDepositQueryError,
  invalidDepositQueryMessage,
  parseDepositQuery,
} from './deposit-query.js';

/**
 * The deposits query's parsing, which is the part of a paged read a test can drive exhaustively
 * without a network. Every branch of `parseDepositQuery` is a case here, and the two behaviours
 * worth pinning are the *asymmetry* between a clamped limit and a refused one, and the empty-vs-
 * absent distinction the payments history also makes.
 */
describe('parseDepositQuery', () => {
  it('defaults the limit and leaves the cursor unset when nothing is given', () => {
    expect(parseDepositQuery({})).toEqual({ limit: DEPOSITS_DEFAULT_LIMIT, cursor: undefined });
  });

  it('reads a whole-number limit', () => {
    expect(parseDepositQuery({ limit: '5' })).toEqual({ limit: 5, cursor: undefined });
  });

  it('clamps a limit at the ceiling rather than refusing it', () => {
    // A cap, not a refusal: the caller is reading their own wallet, so asking for more than this
    // gets this many - the same call the payments history makes, and the reason the DTO does not
    // carry a `@Max()` that would reject `limit=1000` at the pipe.
    expect(parseDepositQuery({ limit: '1000' }).limit).toBe(DEPOSITS_MAX_LIMIT);
  });

  it('clamps a limit at the floor', () => {
    expect(parseDepositQuery({ limit: '0' }).limit).toBe(1);
    expect(parseDepositQuery({ limit: '-3' }).limit).toBe(1);
  });

  it('refuses a limit that is not a whole number, and an empty one', () => {
    for (const bad of ['abc', '1.5', '', '  ']) {
      expect(() => parseDepositQuery({ limit: bad }), `limit=${JSON.stringify(bad)}`).toThrow(
        InvalidDepositQueryError,
      );
    }
  });

  it('reads a cursor, and refuses an empty one', () => {
    expect(parseDepositQuery({ cursor: '128849018880' }).cursor).toBe('128849018880');
    // Empty is "the key was sent with nothing in it", which is not the same as "not provided".
    expect(() => parseDepositQuery({ cursor: '' })).toThrow(InvalidDepositQueryError);
  });

  it('says which parameter was refused, so a 400 can name it', () => {
    try {
      parseDepositQuery({ limit: 'abc' });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof InvalidDepositQueryError)) {
        throw error;
      }

      expect(error.problem).toBe('limit');
      expect(error.input).toBe('abc');
      expect(invalidDepositQueryMessage(error.problem)).toContain('limit');
    }
  });
});
