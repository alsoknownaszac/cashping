/**
 * The fourth thing `StellarService` asks Horizon: what has been *paid into* an account
 * (`GET /v1/wallet/deposits`).
 *
 * ## Why this exists next to `STELLAR_TRANSACTION_LOOKUP`
 *
 * The two reads answer different questions with different handles. The lookup takes a
 * *transaction hash* the app already recorded and reports whether that specific submission
 * settled - it is about money this app moved. This one takes an *account* and reports the
 * payments Horizon saw arrive, whoever sent them: a deposit from another CashPing user, a
 * transfer from a wallet this app has never heard of, a Testnet faucet. Nothing in the
 * `transactions` table can answer it, because a row is only written when this app creates a
 * payment - so the ledger is the only place the answer exists, and this is the read that goes
 * to it.
 *
 * ## On-demand, and deliberately not stored
 *
 * There is no "deposits" table and no ingest job, and that is the design rather than a
 * staging post: Horizon is the source of truth for what landed, it is already the source for
 * balances (Step 20), and a second copy would be a second answer that a reorg, a backfill or
 * a missed webhook could put out of step with the ledger. A read here is a read of Horizon on
 * this request, exactly like `loadBalances`.
 *
 * ## The page is Horizon's own, cursor and all
 *
 * `nextCursor` is the `paging_token` of the last payment in the page - the value a client
 * passes back as `?cursor=` to walk to older deposits. It is Horizon's token, not an offset
 * this app computes, because Horizon's paging is stable against new payments arriving between
 * two calls and an offset is not (a deposit landing between page one and page two would shift
 * every later row and hide one).
 */
export const STELLAR_PAYMENTS_LOOKUP = Symbol('STELLAR_PAYMENTS_LOOKUP');

/**
 * One payment Horizon reports as arriving at an account.
 *
 * The amount is Horizon's decimal string and stays one - the same rule as `StellarBalanceLine`
 * and `WalletBalances`: Stellar amounts are 7-decimal fixed point, `Number()` would round them,
 * and a money endpoint that rounds is the one thing this app must not be.
 *
 * `assetCode`/`assetIssuer` are `null` for the native asset (XLM), which has neither, the same
 * shape `StellarBalanceLine` uses for the same reason: a caller filtering to a credit asset has
 * to be able to *skip* native rather than fail to represent it.
 */
export interface IncomingStellarPayment {
  /** Horizon's operation id, stable for the life of the deposit. */
  readonly id: string;
  /** Horizon's paging token for this record - the cursor that walks to the page after it. */
  readonly pagingToken: string;
  /** When the ledger that carries it closed, as Horizon's ISO-8601 string. */
  readonly createdAt: string;
  /** The hash of the transaction the payment was part of, for an explorer. */
  readonly transactionHash: string;
  /** The account the money came from, in `G...` form. */
  readonly from: string;
  /** The amount received, as Horizon's decimal string. */
  readonly amount: string;
  /** The asset code, or `null` when the payment is native (XLM). */
  readonly assetCode: string | null;
  /** The asset's issuer, or `null` when the payment is native (XLM). */
  readonly assetIssuer: string | null;
}

/** One page of incoming payments, newest first, with the cursor to the next. */
export interface IncomingPaymentPage {
  readonly payments: readonly IncomingStellarPayment[];
  /**
   * The cursor for the next (older) page, or `null` when this page was the last.
   *
   * `null` rather than a bare "yes" so a client cannot page past the end: the same shape
   * `PaymentListResponseDto.hasMore` has, expressed as the token Horizon actually needs.
   */
  readonly nextCursor: string | null;
}

export interface StellarPaymentsLookupOptions {
  /** How many payments to ask Horizon for, at most. */
  readonly limit: number;
  /** Horizon paging token to start *before*, i.e. the `nextCursor` of a previous page. */
  readonly cursor?: string;
}

export interface StellarPaymentsLookup {
  /**
   * The payments Horizon reports arriving at `accountId`, newest first.
   *
   * Resolves with an empty page for an account Horizon has never seen (a wallet that is not
   * funded yet simply has no deposits), and rejects only when Horizon could not be asked - the
   * same distinction `StellarAccountSource` draws, and the one that keeps "no deposits" from
   * being reported when the truth is "we do not know".
   */
  listIncoming(
    accountId: string,
    options: StellarPaymentsLookupOptions,
  ): Promise<IncomingPaymentPage>;
}

/**
 * Horizon could not be asked for the account's payments: unreachable, timed out, 5xx, or an
 * unreadable body.
 *
 * Distinct from an empty page for the same reason `StellarAccountSourceError` is distinct from
 * `StellarAccountNotFoundError`: the correct reaction is opposite. "No deposits" is an answer;
 * "we could not ask" is a retry, and reporting the first when the second is true would tell a
 * user their money is not there.
 */
export class StellarPaymentsLookupError extends Error {
  constructor(
    readonly accountId: string,
    options?: { cause?: unknown },
  ) {
    super(`Horizon could not list payments for Stellar account ${accountId}`, options);
    this.name = 'StellarPaymentsLookupError';
  }
}
