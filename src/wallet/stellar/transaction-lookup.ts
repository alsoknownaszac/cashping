/**
 * The third thing `StellarService` needs from Horizon: what became of a transaction (Step 28).
 *
 * `StellarTransactionSubmitter` answers "did Horizon take this"; this answers "did it land, and
 * did it work" - the question Step 27 deliberately left open (acceptance is not settlement) and
 * the one a payment row sitting in `PROCESSING` is waiting for. The handle is the hash the row
 * recorded before submission, so nothing here needs the envelope, the key or the sender.
 *
 * ## Why the answers are data rather than exceptions
 *
 * `StellarTransactionSubmitter` throws, because a submission that failed *interrupted an action*
 * and the two failure classes (refused / no answer) call for opposite reactions. A lookup is
 * read repeatedly by a poller, and one of its answers - "Horizon has no such transaction" - is
 * the *normal* state of a transaction submitted two seconds ago. Making the common case an
 * exception would mean every tick's control flow ran through `catch`, so the port returns a
 * discriminated result and the caller decides.
 *
 * The three answers, and there are only three:
 *
 * - `settled` - Horizon has it in a closed ledger. `successful` says whether the ledger accepted
 *   it; `transactionCode` names the transaction-level result code (`tx_failed`, `tx_bad_seq`)
 *   when the lookup could read it, and is `null` when it could not, because the *fact* is
 *   `successful` and the code is commentary.
 * - `not-found` - Horizon answered, and the answer is that this hash is not in its history.
 *   Not an error and not a verdict: a transaction that has not been ingested yet, and one that
 *   will never exist, look identical here. Which of the two it is is a question about time, and
 *   the deadline (`submission_deadline`) is what answers it - see `confirmation-triage.ts`.
 * - `unavailable` - Horizon did not answer (unreachable, timed out, 5xx, an unreadable body).
 *   Nothing about the transaction may be concluded from this, which is why it is its own answer
 *   rather than folded into `not-found`: reading "could not ask" as "is not there" would fail
 *   payments that landed.
 */
export const STELLAR_TRANSACTION_LOOKUP = Symbol('STELLAR_TRANSACTION_LOOKUP');

/** Horizon has the transaction in a ledger. */
export interface SettledTransaction {
  /** The ledger it was included in. */
  readonly ledger: number;
  /** Whether the ledger accepted it: `false` is an on-ledger failure, which is final. */
  readonly successful: boolean;
  /**
   * The transaction-level result code (`tx_failed`, `tx_too_late`), or `null` when the result
   * XDR could not be read. Short, snake-cased and Horizon-shaped, so it can go straight into the
   * `failure_reason` column under `landed-unsuccessful:` - the same prefix the submit path writes
   * for the same codes, because a record this object was built from is in a ledger (Step 28).
   */
  readonly transactionCode: string | null;
}

/** What Horizon says about one hash. Exactly one of the three, never two. */
export type TransactionLookupResult =
  | ({ readonly kind: 'settled' } & SettledTransaction)
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export interface StellarTransactionLookup {
  /**
   * Looks `hash` up. Resolves for every outcome Horizon gave; rejects only for a bug in this
   * app (a malformed hash reaching the SDK, say), which is why the poller treats a rejection as
   * a retry rather than as an answer about the payment.
   */
  lookup(hash: string): Promise<TransactionLookupResult>;
}
