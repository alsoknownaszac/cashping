import {
  BASE_FEE,
  TransactionBuilder,
  type Transaction,
  type TransactionSource,
  type xdr,
} from '@stellar/stellar-sdk';
import type { Memo } from '@stellar/stellar-sdk';

/**
 * How long a built transaction stays valid, in seconds, unless the caller says
 * otherwise.
 *
 * Three minutes is the widely used window: long enough for a user to approve and
 * for a surge in fees to clear, short enough that a transaction abandoned by a
 * crashed process cannot land hours later against a balance that has moved on.
 * `TimeoutInfinite` (0) is the SDK default and is not what a wallet wants - it
 * makes every transaction replayable forever.
 */
export const TRANSACTION_TIMEOUT_SECONDS = 180;

/** Per-transaction overrides, on top of the session's network and sequence. */
export interface TransactionOptions {
  /** Memo carried by the transaction, when the flow needs one (Step 23+). */
  memo?: Memo;
  /** Maximum fee to pay per operation, in stroops. */
  fee?: string;
  /** Validity window, in seconds. */
  timeoutSeconds?: number;
}

/**
 * One account's sequence number, and the only supported way to build a
 * transaction from it (Step 17).
 *
 * The point of the object is the sequence number it *holds*: it is created from a
 * loaded account inside the per-account lock, every `build` increments it (that is
 * the SDK's `TransactionSource` contract, and it is what makes two builds in one
 * session consecutive rather than identical), and it is discarded when the locked
 * section ends. A session that outlives its section is a session holding a stale
 * sequence number, which is the bug this whole step exists to prevent - so it is
 * not exported from any module the app wires up, and it is not retained anywhere.
 */
export class StellarAccountSession {
  constructor(
    private readonly source: TransactionSource,
    private readonly networkPassphrase: string,
  ) {}

  /** The source account id, as Horizon reported it. */
  get accountId(): string {
    return this.source.accountId();
  }

  /** The sequence number the *next* build will use, as a string. */
  get sequenceNumber(): string {
    return this.source.sequenceNumber();
  }

  /**
   * Builds one transaction: `operations`, plus a fee (per operation, in stroops),
   * a validity window, and an optional memo.
   *
   * Everything a caller may leave out is defaulted here rather than at the call
   * sites, so no flow can accidentally build a transaction with no time bounds or
   * with the wrong network passphrase.
   */
  build(operations: readonly xdr.Operation[], options: TransactionOptions = {}): Transaction {
    // Stellar rejects a transaction with no operations (`tx_missing_operations`),
    // so this is a programming error - refused with a message that says which
    // rule was broken, not a 500 several layers away.
    if (operations.length === 0) {
      throw new Error('A Stellar transaction must carry at least one operation');
    }

    const builder = new TransactionBuilder(this.source, {
      fee: options.fee ?? BASE_FEE,
      networkPassphrase: this.networkPassphrase,
      ...(options.memo === undefined ? {} : { memo: options.memo }),
    });

    for (const operation of operations) {
      builder.addOperation(operation);
    }

    return builder.setTimeout(options.timeoutSeconds ?? TRANSACTION_TIMEOUT_SECONDS).build();
  }
}
