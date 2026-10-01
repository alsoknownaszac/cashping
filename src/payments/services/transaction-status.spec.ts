import { describe, expect, it } from 'vitest';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import {
  TRANSACTION_TRANSITIONS,
  TransactionTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
} from './transaction-status.js';

/**
 * The state machine, pinned (Step 27).
 *
 * Three kinds of assertion, and each is here for a different reason:
 *
 * - **Every status is in the table.** A status added to the enum and forgotten here would leave
 *   `TRANSACTION_TRANSITIONS[status]` `undefined`, and `canTransition` would throw a `TypeError`
 *   rather than answering - a failure that only appears on the code path that reads it. The
 *   `Object.keys` assertion makes that a compile-and-test-time fact instead.
 * - **The two transitions this step writes are allowed.** If either were refused, a payment could
 *   not be claimed or could not be failed, and the submission path would be dead.
 * - **The refusals are refusals.** `SUCCESSFUL` nowhere, `FAILED` nowhere, and nothing may go
 *   backwards; these are the rows that make "a payment's answer cannot change" a property of the
 *   code rather than of everyone's memory.
 */

const ALL_STATUSES = Object.values(TransactionStatus);

describe('TRANSACTION_TRANSITIONS', () => {
  it('has an entry for every status, so no lookup can fall off the table', () => {
    expect(Object.keys(TRANSACTION_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('lets a claimed payment be submitted, and lets a submitted payment be answered', () => {
    expect(canTransition(TransactionStatus.PENDING, TransactionStatus.PROCESSING)).toBe(true);
    expect(canTransition(TransactionStatus.PROCESSING, TransactionStatus.FAILED)).toBe(true);
    expect(canTransition(TransactionStatus.PROCESSING, TransactionStatus.SUCCESSFUL)).toBe(true);
  });

  it('refuses every way back, and every way out of an answer', () => {
    expect(canTransition(TransactionStatus.PROCESSING, TransactionStatus.PENDING)).toBe(false);
    expect(canTransition(TransactionStatus.SUCCESSFUL, TransactionStatus.PROCESSING)).toBe(false);
    expect(canTransition(TransactionStatus.SUCCESSFUL, TransactionStatus.FAILED)).toBe(false);
    expect(canTransition(TransactionStatus.FAILED, TransactionStatus.PROCESSING)).toBe(false);
    expect(canTransition(TransactionStatus.FAILED, TransactionStatus.SUCCESSFUL)).toBe(false);
  });

  it('refuses to skip submission entirely', () => {
    // A payment that was never submitted cannot be successful: Step 28 resolves a *submitted*
    // transaction, and there is no hash for it to poll.
    expect(canTransition(TransactionStatus.PENDING, TransactionStatus.SUCCESSFUL)).toBe(false);
    expect(canTransition(TransactionStatus.PENDING, TransactionStatus.FAILED)).toBe(false);
  });
});

describe('isTerminal', () => {
  it('is true for the two statuses that are answers, and false for the two that are not', () => {
    expect(isTerminal(TransactionStatus.SUCCESSFUL)).toBe(true);
    expect(isTerminal(TransactionStatus.FAILED)).toBe(true);
    expect(isTerminal(TransactionStatus.PENDING)).toBe(false);
    expect(isTerminal(TransactionStatus.PROCESSING)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('returns quietly for a legal transition', () => {
    expect(() =>
      assertTransition('tx-1', TransactionStatus.PENDING, TransactionStatus.PROCESSING),
    ).not.toThrow();
  });

  it('names the payment, where it was, and where it was going', () => {
    const failure = (() => {
      try {
        assertTransition('tx-1', TransactionStatus.SUCCESSFUL, TransactionStatus.FAILED);
      } catch (error) {
        return error;
      }

      throw new Error('expected the transition to be refused');
    })();

    expect(failure).toBeInstanceOf(TransactionTransitionError);
    expect((failure as TransactionTransitionError).from).toBe(TransactionStatus.SUCCESSFUL);
    expect((failure as TransactionTransitionError).to).toBe(TransactionStatus.FAILED);
    expect((failure as Error).message).toBe(
      'Payment tx-1 cannot move from SUCCESSFUL to FAILED (nothing)',
    );
  });
});
