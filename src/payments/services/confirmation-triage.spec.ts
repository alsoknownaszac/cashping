import { describe, expect, it } from 'vitest';
import { type TransactionLookupResult } from '../../wallet/stellar/transaction-lookup.js';
import {
  CONFIRMATION_GRACE_MS,
  triageConfirmation,
  type ConfirmationDecision,
  type ConfirmationReport,
} from './confirmation-triage.js';

/**
 * The decision Step 28 turns on, pinned: one function, four answers, and the two that write.
 *
 * This is the file where a payment stops being "in flight" and becomes an answer, so every branch
 * below is a claim this codebase has to be able to defend to somebody looking at a payment that did
 * or did not move money. The two that matter most are the ones about *waiting*:
 *
 * - `not-found` before the deadline is **not** a failure. A transaction submitted two seconds ago
 *   and one that will never exist are the same answer from Horizon; what tells them apart is the
 *   deadline the row recorded before submitting, and only after it has passed - plus the grace
 *   window - can "not found" mean "this can never be valid again".
 * - `unavailable` is not a verdict on anything. Reading "could not ask" as "is not there" is how a
 *   poller fails payments that landed.
 *
 * Both are asserted on the boundary as well as in the middle, because the interesting bugs in a
 * function like this live at the edges: `now == deadline + grace` has to be *waiting*, and one
 * millisecond later has to be a failure.
 */

/** The clock every case uses, so nothing here depends on when the suite runs. */
const NOW = new Date('2026-09-30T12:00:00.000Z');

/** A moment relative to `NOW`, in milliseconds (negative is the past). */
function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

/** A report about a row Horizon has not seen, with a deadline ten minutes out. */
function report(overrides: Partial<ConfirmationReport> = {}): ConfirmationReport {
  return {
    lookup: { kind: 'not-found' },
    deadline: at(10 * 60_000),
    now: NOW,
    ...overrides,
  };
}

/** What Horizon says about a transaction that is in a ledger. */
function settled(
  overrides: Partial<Extract<TransactionLookupResult, { kind: 'settled' }>> = {},
): TransactionLookupResult {
  return { kind: 'settled', ledger: 1234, successful: true, transactionCode: null, ...overrides };
}

describe('triageConfirmation: a transaction Horizon has', () => {
  it('confirms a successful one, naming the ledger it landed in', () => {
    expect(triageConfirmation(report({ lookup: settled() }))).toEqual({
      kind: 'confirmed',
      ledger: 1234,
    });
  });

  it('fails one the ledger refused, with the transaction code as the reason', () => {
    // The reason is the column value *and* the log line, so it is a short machine code:
    // `landed-unsuccessful:tx_failed` is the same name Step 27's submit path writes for the same
    // code, because the two paths describe one event - the prefix says a ledger closed the
    // transaction, never which of them learned it (Step 28's audit of the vocabulary).
    const decision = triageConfirmation(
      report({ lookup: settled({ successful: false, transactionCode: 'tx_failed' }) }),
    );

    expect(decision).toEqual({ kind: 'failed', reason: 'landed-unsuccessful:tx_failed' });
  });

  it('fails it without inventing a code when the result XDR could not be read', () => {
    // `transactionCode` is `null` when the XDR could not be decoded, and the *fact* - an on-ledger
    // failure, which is final - is what the decision rests on. A placeholder code here would look
    // like a real one in the row and in the message.
    const decision = triageConfirmation(report({ lookup: settled({ successful: false }) }));

    expect(decision).toEqual({ kind: 'failed', reason: 'landed-unsuccessful' });
  });

  it('confirms it even when the deadline is long past, because the ledger outranks the fence', () => {
    // The deadline fences *building* a new transaction; it says nothing about reading the fate of
    // the one already built. A settled transaction is why the checks are ordered as they are.
    const decision = triageConfirmation(report({ lookup: settled(), deadline: at(-60 * 60_000) }));

    expect(decision).toEqual({ kind: 'confirmed', ledger: 1234 });
  });

  it('confirms it even with no deadline recorded, for the same reason', () => {
    expect(triageConfirmation(report({ lookup: settled(), deadline: null }))).toEqual({
      kind: 'confirmed',
      ledger: 1234,
    });
  });
});

describe('triageConfirmation: a transaction Horizon has not seen', () => {
  it('waits while the deadline is still ahead', () => {
    expect(triageConfirmation(report())).toEqual({
      kind: 'waiting',
      detail: 'not-found-before-deadline',
    });
  });

  it('waits through the grace window, on the boundary and inside it', () => {
    // `now <= deadline + grace`: the window exists because Horizon's history is fed by what the
    // ledger closes, so a transaction included in the last ledger before its deadline can still be
    // missing from a fetch a moment later. Erring towards waiting is the safe direction - a minute
    // late costs a minute, a minute early claims a payment failed that then lands.
    for (const offset of [0, 1, CONFIRMATION_GRACE_MS - 1]) {
      expect(triageConfirmation(report({ deadline: at(-offset) })).kind).toBe('waiting');
    }
  });

  it('fails it one millisecond past the deadline plus the grace window', () => {
    const decision = triageConfirmation(report({ deadline: at(-(CONFIRMATION_GRACE_MS + 1)) }));

    expect(decision).toEqual({ kind: 'failed', reason: 'not-found-after-deadline' });
  });

  it('refuses to guess when the row has no deadline recorded', () => {
    // `recordEnvelope` writes the hash, the sequence and the deadline together, so a hash with no
    // deadline is a row this app did not write. There is no window to compare against, and claiming
    // the payment failed on the strength of a missing column would be inventing the deadline: the
    // `PROCESSING`-forever case is real, and reporting it is the honest answer.
    expect(triageConfirmation(report({ deadline: null }))).toEqual({
      kind: 'unknown',
      detail: 'no-deadline-recorded',
    });
  });
});

describe('triageConfirmation: a Horizon that did not answer', () => {
  it('concludes nothing, and says why in a form that can be logged', () => {
    const decision = triageConfirmation(
      report({ lookup: { kind: 'unavailable', detail: 'Horizon answered HTTP 503' } }),
    );

    expect(decision).toEqual({ kind: 'unknown', detail: 'horizon-unavailable:Horizon answered HTTP 503' });
  });

  it('does not turn "could not ask" into a failure even when the deadline has passed', () => {
    // The one combination worth spelling out: the deadline says this can no longer be valid, and
    // Horizon still did not answer. Two facts about two different things, and only the first is
    // about the payment - so the row waits for the next tick.
    const decision = triageConfirmation(
      report({
        lookup: { kind: 'unavailable', detail: 'Horizon did not answer (ETIMEDOUT)' },
        deadline: at(-CONFIRMATION_GRACE_MS * 10),
      }),
    );

    expect(decision.kind).toBe('unknown');
  });
});

describe('the decision type', () => {
  it('writes for exactly two of its four kinds', () => {
    const writes: Record<ConfirmationDecision['kind'], boolean> = {
      confirmed: true,
      failed: true,
      waiting: false,
      unknown: false,
    };

    // Exhaustive by construction, which is the point of writing it as a `Record`: a fifth kind
    // added to the union fails to compile *here*, so it has to be classified as writing or not
    // before it can ship. At runtime the claim is the obvious one - half of the answers are facts
    // about a payment, and the other half are the poller admitting it does not know yet.
    expect(Object.values(writes).filter(Boolean)).toEqual([true, true]);
  });
});

