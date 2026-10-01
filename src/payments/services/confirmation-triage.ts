import { type TransactionLookupResult } from '../../wallet/stellar/transaction-lookup.js';

/**
 * What a poll of one recorded transaction decided (Step 28).
 *
 * A pure function over three inputs - what Horizon said, the row's deadline and the clock -
 * because this is the step where a payment stops being "in flight" and becomes an answer, and
 * every branch below is a decision this codebase has to be able to defend to somebody looking at
 * a payment that did or did not move money:
 *
 * | what Horizon said | the deadline | decision |
 * | --- | --- | --- |
 * | it is in a ledger, `successful` | - | `confirmed` |
 * | it is in a ledger, not successful | - | `failed` (`landed-unsuccessful:<code>`) |
 * | it has never seen the hash | still ahead | `waiting` (`not-found-before-deadline`) |
 * | it has never seen the hash | passed by the grace window | `failed` (`not-found-after-deadline`) |
 * | it has never seen the hash | unknown | `unknown` (`no-deadline-recorded`) |
 * | it did not answer | - | `unknown` (`horizon-unavailable`) |
 *
 * ## Why "not found" is not a verdict on its own
 *
 * A transaction submitted two seconds ago and a transaction that will never exist are the same
 * answer from Horizon: nothing. What tells them apart is the deadline the row recorded before it
 * submitted - the transaction's own `maxTime` - and only *after* it has passed can "not found"
 * mean "this transaction can never be valid again". Reading it as a failure before then would
 * fail payments that were merely in the ledger's queue; reading it as a failure *never* is the
 * `PROCESSING`-forever case this step exists to close.
 *
 * ## Why the grace window exists
 *
 * `now > deadline` is when Stellar itself will no longer accept the transaction, but Horizon's
 * history is fed from what the ledger closes: a transaction included in the last ledger before
 * its deadline can still be missing from a fetch a moment later (`paging` lag plus ingest). The
 * window is therefore a *reading* of the network's own delay, and it is safe because it is
 * bounded and it errs towards waiting: a payment resolved `not-found-after-deadline` a minute
 * later than strictly necessary costs a minute, while one resolved early claims a payment failed
 * that then appears in a ledger with the money moved.
 *
 * ## What this deliberately cannot decide
 *
 * A `PROCESSING` row with *no* hash is not a poller's question at all: there is nothing to look
 * up, and the state means a claim that never recorded an envelope (see
 * `docs/step-28-29-proposal.md` §5 for which of Step 27's cases this closes and which it does
 * not). The sweep reports those rows rather than guessing at them.
 */
export const CONFIRMATION_GRACE_MS = 60_000;

/** What the sweep learned about one row, in the terms the triage needs. */
export interface ConfirmationReport {
  readonly lookup: TransactionLookupResult;
  /** The transaction's own `maxTime`, as the row recorded it. `null` only if the row lost it. */
  readonly deadline: Date | null;
  readonly now: Date;
}

/** What one poll decided. `confirmed` and `failed` are the two that write. */
export type ConfirmationDecision =
  | { readonly kind: 'confirmed'; readonly ledger: number }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * The decision, as one function.
 *
 * Order matters only in that `settled` is checked first: Horizon having the transaction is a
 * fact about it that no deadline can override, which is why a transaction that landed is
 * resolved even if the row's deadline is in the past (the deadline fences *building* a new
 * transaction, not reading this one's fate).
 */
export function triageConfirmation(report: ConfirmationReport): ConfirmationDecision {
  const { lookup, deadline, now } = report;

  if (lookup.kind === 'settled') {
    if (lookup.successful) {
      return { kind: 'confirmed', ledger: lookup.ledger };
    }

    return {
      kind: 'failed',
      // The transaction-level code when the result XDR could be read, and just the fact when it
      // could not - never a placeholder that looks like a code. See `transactionCodeOf`.
      reason:
        lookup.transactionCode === null
          ? 'landed-unsuccessful'
          : `landed-unsuccessful:${lookup.transactionCode}`,
    };
  }

  if (lookup.kind === 'unavailable') {
    return { kind: 'unknown', detail: `horizon-unavailable:${lookup.detail}` };
  }

  if (deadline === null) {
    // A hash with no deadline is a row this app did not write (`recordEnvelope` writes all three
    // together) - so there is no window to compare against, and claiming the payment failed on
    // the strength of a missing column would be inventing the deadline.
    return { kind: 'unknown', detail: 'no-deadline-recorded' };
  }

  if (now.getTime() <= deadline.getTime() + CONFIRMATION_GRACE_MS) {
    return { kind: 'waiting', detail: 'not-found-before-deadline' };
  }

  return { kind: 'failed', reason: 'not-found-after-deadline' };
}
