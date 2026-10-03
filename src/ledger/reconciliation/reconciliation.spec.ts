import { describe, expect, it } from 'vitest';
import { Amount } from '../../common/money/amount.js';
import { isZeroAmount, reconcileAccount, type ReconciliationOutcome } from './reconciliation.js';

/**
 * The comparison at the heart of Step 31, pinned offline (Step 31).
 *
 * Every answer the reconciliation service can report is decided here, in pure arithmetic with no
 * database and no network, which is the point of splitting it out: the service's own spec is about
 * *which* accounts it reads, and this one is about what "these two numbers agree" means - including
 * the two asymmetries that are easy to get wrong (a missing USDC line is zero, not unknown; a
 * negative drift is a real answer, not a bug).
 */

/** Parse a test amount through the same door a caller would. */
const amount = (value: string): Amount => Amount.fromString(value);

/** The drift an outcome carries, asserted to be a drift first so the type narrows. */
function driftOf(outcome: ReconciliationOutcome): string {
  if (outcome.verdict !== 'drifted') {
    throw new Error(`expected a drift, got "${outcome.verdict}"`);
  }

  return outcome.drift.toString();
}

describe('reconcileAccount', () => {
  it('matches when Horizon holds exactly what the internal net claims', () => {
    expect(reconcileAccount(amount('5'), '5.0000000')).toEqual({ verdict: 'matched' });
  });

  it('matches two zeros - an untouched account on both sides', () => {
    expect(reconcileAccount(amount('0'), '0.0000000')).toEqual({ verdict: 'matched' });
  });

  it('reports a negative drift when the network holds less than the records claim', () => {
    expect(driftOf(reconcileAccount(amount('5'), '3.0000000'))).toBe('-2');
  });

  it('reports a positive drift when the network holds more than the records claim', () => {
    expect(driftOf(reconcileAccount(amount('5'), '7.0000000'))).toBe('2');
  });

  it('reads a missing USDC line as zero, so a recorded receipt with no line is a drift', () => {
    expect(driftOf(reconcileAccount(amount('5'), null))).toBe('-5');
  });

  it('reads a missing USDC line as zero and matches when nothing was recorded either', () => {
    expect(reconcileAccount(amount('0'), null)).toEqual({ verdict: 'matched' });
  });

  it('compares at the last stroop: one unit apart is a drift, one unit equal is not', () => {
    expect(reconcileAccount(amount('0.0000001'), '0.0000001')).toEqual({ verdict: 'matched' });
    expect(reconcileAccount(amount('0.0000001'), '0.0000000').verdict).toBe('drifted');
  });

  it('does not lose the seventh decimal in a large balance', () => {
    expect(reconcileAccount(amount('123456789012.1234567'), '123456789012.1234567')).toEqual({
      verdict: 'matched',
    });
  });
});

describe('isZeroAmount', () => {
  it('is true for zero and for a zero written any way', () => {
    expect(isZeroAmount(amount('0'))).toBe(true);
    expect(isZeroAmount(amount('0.0000000'))).toBe(true);
  });

  it('is false for the smallest amount in either direction', () => {
    expect(isZeroAmount(amount('0.0000001'))).toBe(false);
    // A negative can only be produced by arithmetic (`fromString` refuses a sign), which is exactly
    // how a real drift below zero arrives.
    expect(isZeroAmount(amount('0').minus(amount('0.0000001')))).toBe(false);
  });
});
