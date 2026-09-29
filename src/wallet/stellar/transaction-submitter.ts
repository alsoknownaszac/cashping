import type { Transaction } from '@stellar/stellar-sdk';

/**
 * The second thing `StellarService` needs from a Horizon server: somewhere to send
 * a *signed* transaction (Step 19).
 *
 * It is a port of its own rather than a second method on `StellarAccountSource`,
 * because the two answer different questions. That one is about a *snapshot* - what
 * the account's sequence number is right now - and every failure it reports is a
 * statement about whether the account could be read. This one is about *intent*:
 * the transaction is already signed and irreversible at the moment it is handed
 * over, so "Horizon said no" and "Horizon never answered" mean very different
 * things, and neither is a statement about the account. Folding them together would
 * mean one error type covering both, and the entire point of the two error classes
 * below is that a caller must not have to guess which one it is holding.
 *
 * Keeping it separate is also what keeps the specs offline: `StellarService`'s race
 * spec needs a fixed set of submitted transactions, not a network round trip, and it
 * already has a fake Horizon to hang a submitter on.
 */
export const STELLAR_TRANSACTION_SUBMITTER = Symbol('STELLAR_TRANSACTION_SUBMITTER');

/** What Horizon answered when it accepted a transaction. */
export interface SubmittedTransaction {
  /**
   * The transaction hash: the handle for *what* landed.
   *
   * This is the value an operator pastes into an explorer and the value a log line
   * carries, so it is returned rather than discarded - a provisioning log that says
   * "funded" without saying "as transaction X" is a claim nobody can check. It is
   * not a secret: the hash names a public ledger entry.
   */
  readonly hash: string;
  /** The ledger it was included in, as Horizon reported it (`undefined` if absent). */
  readonly ledger: number | undefined;
}

export interface StellarTransactionSubmitter {
  /**
   * Submits `transaction` and resolves once Horizon has accepted it.
   *
   * A rejection is always one of the two errors below and never a raw SDK error:
   * callers decide what to do about a failure, and that decision needs the
   * *classification*, not the SDK's vocabulary.
   */
  submit(transaction: Transaction): Promise<SubmittedTransaction>;
}

/**
 * Horizon evaluated the transaction and refused it.
 *
 * The result codes are the whole reason this type exists. A transaction-level code
 * (`tx_bad_seq`, `tx_insufficient_fee`, `tx_too_late`) means the transaction never
 * reached its operations; an operation-level one (`op_underfunded`,
 * `op_low_reserve`) names the operation that failed and why. For a retry that is
 * actionable information: `tx_bad_seq` is a conflict with a snapshot that moved,
 * and a resubmission built from a fresh load may well succeed, while
 * `op_low_reserve` says the balance is the problem and will still be.
 *
 * Crucially, this error means the transaction **did not land**. Horizon answered
 * *about* it, which is a stronger statement than any timeout can make.
 */
export class StellarSubmissionRejectedError extends Error {
  constructor(
    /** `tx_failed`, `tx_bad_seq`, ... - Horizon's transaction-level outcome. */
    readonly transactionCode: string,
    /**
     * The operation-level codes, in operation order. Empty when the transaction
     * failed a transaction-level check and no operation was evaluated at all
     * (`getResultCodes()` normalises Horizon's omission).
     */
    readonly operationCodes: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(
      `Horizon rejected the transaction: ${transactionCode}${
        operationCodes.length === 0 ? '' : ` (${operationCodes.join(', ')})`
      }`,
      options,
    );
    this.name = 'StellarSubmissionRejectedError';
  }
}

/**
 * Horizon did not give a verdict: unreachable, timed out, 5xx, or an answer that
 * could not be read as a submission result.
 *
 * **The transaction's fate is unknown, and this error does not pretend
 * otherwise.** A request that times out because Horizon was slow and a request that
 * times out because the connection died after Horizon committed are the same
 * exception here, and `tx_bad_seq` on a later resubmission is how the app finds out
 * which one it was. That is why nothing in this app may treat this error as "it did
 * not happen": the safe reading is "it may have", and every retry built on this
 * error has to be idempotent. Step 19's trustline submission is, and
 * `usdc-trustline.ts` records why.
 *
 * `detail` is a short, non-sensitive classification (`Horizon did not answer
 * (ECONNREFUSED)`, `Horizon answered HTTP 503`) rather than a raw message, because
 * the SDK's own messages carry a full URL and sometimes the whole response body,
 * and error strings end up in logs.
 */
export class StellarSubmissionUnavailableError extends Error {
  constructor(
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Stellar submission failed: ${detail}`, options);
    this.name = 'StellarSubmissionUnavailableError';
  }
}
