import { describe, expect, it } from 'vitest';
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  InvalidHandleError,
  RESERVED_HANDLES,
  assertHandleAllowed,
  handleProblem,
  normalizeHandle,
} from './handle.js';

/**
 * Step 15: the handle rules, as rules.
 *
 * The interesting cases are the boundaries (3 and 20 are allowed, 2 and 21 are not)
 * and the near-misses (`adminn` is a fine handle, `admin` is not) - a blocklist
 * that also rejects `administration` is a blocklist that gets removed the first
 * time a real user hits it.
 */

describe('normalizeHandle', () => {
  it('lower-cases, so the unique index is the case-insensitive one', () => {
    expect(normalizeHandle('Miriam')).toBe('miriam');
    expect(normalizeHandle('MIRIAM')).toBe('miriam');
    // The pair the audit checklist names.
    expect(normalizeHandle('@Miriam')).toBe(normalizeHandle('@miriam'));
  });

  it('drops one leading @, because that is how handles are written', () => {
    expect(normalizeHandle('@miriam')).toBe('miriam');
    expect(normalizeHandle('  @miriam  ')).toBe('miriam');
  });

  it('strips only one @, so @@miriam is not quietly accepted', () => {
    expect(normalizeHandle('@@miriam')).toBe('@miriam');
    expect(handleProblem('@@miriam')).toBe('characters');
  });

  it('leaves an interior space in place so the character rule catches it', () => {
    expect(normalizeHandle('mir iam')).toBe('mir iam');
    expect(handleProblem('mir iam')).toBe('characters');
  });
});

describe('handleProblem - length bounds', () => {
  it('rejects one character below the minimum', () => {
    expect(handleProblem('ab')).toBe('too_short');
  });

  it('accepts the minimum and the maximum exactly', () => {
    expect(handleProblem('a'.repeat(HANDLE_MIN_LENGTH))).toBeNull();
    expect(handleProblem('a'.repeat(HANDLE_MAX_LENGTH))).toBeNull();
  });

  it('rejects one character above the maximum', () => {
    expect(handleProblem('a'.repeat(HANDLE_MAX_LENGTH + 1))).toBe('too_long');
  });

  it('measures the normalized value, not the submitted one', () => {
    // Three characters after the @ is dropped, so this is long enough...
    expect(handleProblem('@abc')).toBeNull();
    // ...and this is not, even though the raw string is four characters.
    expect(handleProblem('@ab')).toBe('too_short');
  });

  it('reports the length problem before the character problem', () => {
    // A two-character handle with a space in it is both too short and invalid;
    // "too short" is the one the user can act on.
    expect(handleProblem('a ')).toBe('too_short');
  });
});

describe('handleProblem - allowed characters', () => {
  it.each([
    ['letters and digits', 'miriam2026'],
    ['underscores', 'miriam_owusu_2'],
    ['a leading underscore', '_miriam'],
    ['a trailing underscore', 'miriam_'],
    ['digits only', '233'],
  ])('accepts %s', (_label, handle) => {
    expect(handleProblem(handle)).toBeNull();
  });

  it.each([
    ['a hyphen', 'miriam-owusu'],
    ['a dot', 'miriam.owusu'],
    ['an inner space', 'mir iam'],
    ['an accented letter', 'miriamé'],
    ['an emoji', 'miriam🙂'],
    ['an at sign inside', 'mir@iam'],
  ])('rejects %s', (_label, handle) => {
    expect(handleProblem(handle)).toBe('characters');
  });
});

describe('handleProblem - reserved words', () => {
  it('rejects the three names the spec calls out', () => {
    expect(handleProblem('admin')).toBe('reserved');
    expect(handleProblem('support')).toBe('reserved');
    expect(handleProblem('cashping')).toBe('reserved');
  });

  it('rejects reserved words whatever the case or @ prefix', () => {
    expect(handleProblem('@Admin')).toBe('reserved');
    expect(handleProblem('CASH_PING')).toBe('reserved');
  });

  it('rejects underscore variants, which are different strings and just as misleading', () => {
    expect(handleProblem('cash_ping')).toBe('reserved');
    expect(handleProblem('cashping_support')).toBe('reserved');
  });

  it('does not reject a handle that merely starts like a reserved word', () => {
    expect(handleProblem('adminn')).toBeNull();
    expect(handleProblem('administrator2')).toBeNull();
    expect(handleProblem('supportive')).toBeNull();
    expect(handleProblem('cashpingg')).toBeNull();
    expect(handleProblem('miriam')).toBeNull();
  });

  it('only lists reserved words that are themselves valid handles', () => {
    // A reserved word that the character or length rules would reject anyway is
    // dead weight, and a sign that the two lists have drifted apart.
    const unusable = [...RESERVED_HANDLES].filter((entry) => {
      const withoutReservedRule = handleProblem(entry);

      return entry !== entry.toLowerCase() || withoutReservedRule !== 'reserved';
    });

    expect(unusable).toEqual([]);
  });
});

describe('assertHandleAllowed', () => {
  it('returns the canonical form of an acceptable handle', () => {
    expect(assertHandleAllowed('  @Miriam_2 ')).toBe('miriam_2');
  });

  it('throws an InvalidHandleError carrying the reason and the canonical form', () => {
    expect(() => assertHandleAllowed('@Admin')).toThrowError(InvalidHandleError);

    try {
      assertHandleAllowed('@Admin');
      expect.unreachable('assertHandleAllowed should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidHandleError);
      expect((error as InvalidHandleError).problem).toBe('reserved');
      expect((error as InvalidHandleError).handle).toBe('admin');
    }
  });
});
