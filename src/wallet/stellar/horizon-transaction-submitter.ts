import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BadResponseError,
  NetworkError,
  TransactionFailedError,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  HORIZON_SERVER_FACTORY,
  type HorizonServer,
  type HorizonServerFactory,
} from './horizon-account-source.js';
import {
  StellarSubmissionRejectedError,
  StellarSubmissionUnavailableError,
  type StellarTransactionSubmitter,
  type SubmittedTransaction,
} from './transaction-submitter.js';

/**
 * Horizon-backed `StellarTransactionSubmitter` (Step 19).
 *
 * The only behaviour here is the error mapping, and it is the reason this is a class
 * rather than a two-line function: the SDK's `submitTransaction` rejects with
 * `TransactionFailedError` for a rejection, `BadResponseError` for an answer it
 * could not read, and a wrapped axios error (`NetworkError`) for a transport
 * failure - three shapes whose only common ancestor is `Error`. Everything above
 * this layer decides whether to retry, and retrying is exactly what must not be
 * decided from a generic error.
 *
 * The memo-required pre-check the SDK runs before posting is left on (the default).
 * It inspects the transaction's payment-shaped operations and returns immediately
 * when there are none, which is the case for every transaction Step 19 submits; for
 * Step 23's payments it is the check the app *wants*, since Horizon refuses a
 * payment to a memo-required account.
 */
@Injectable()
export class HorizonTransactionSubmitter implements StellarTransactionSubmitter {
  private server: HorizonServer | undefined;

  constructor(
    private readonly config: ConfigService,
    @Inject(HORIZON_SERVER_FACTORY) private readonly createServer: HorizonServerFactory,
  ) {}

  async submit(transaction: Transaction): Promise<SubmittedTransaction> {
    try {
      const response = await this.horizon().submitTransaction(transaction);

      return { hash: response.hash, ledger: response.ledger };
    } catch (cause) {
      throw classifySubmissionFailure(cause);
    }
  }

  /**
   * The client, built once on first use from the same factory and the same config
   * key `HorizonAccountSource` uses.
   *
   * Two `Horizon.Server` instances end up pointing at the same host - one here, one
   * there - and that is deliberate rather than an oversight: a server object is a
   * URL plus an HTTP client, so sharing one would mean sharing a mutable HTTP client
   * with every interceptor and timeout attached to it. When the configured fallback
   * host is actually used, the submitter and the account source have to be moved
   * together, which is the same change - and the same reason - that keeps them apart
   * today.
   */
  private horizon(): HorizonServer {
    this.server ??= this.createServer(this.config.getOrThrow<string>('stellar.horizonUrl'));

    return this.server;
  }
}

/**
 * Turns an SDK submission failure into one of the two errors the app reasons about.
 *
 * Order matters: `TransactionFailedError` extends `BadResponseError`, which extends
 * `NetworkError`, so the most specific check has to come first. Anything that is not
 * a rejection is classified as unavailable, including a failure type this SDK
 * version does not have yet - the conservative direction, because "unavailable"
 * says the transaction's fate is unknown and that is the reading that cannot cause a
 * second, conflicting submission to be built on a false premise.
 */
function classifySubmissionFailure(cause: unknown): Error {
  if (cause instanceof TransactionFailedError) {
    const { transaction, operations } = cause.getResultCodes();

    return new StellarSubmissionRejectedError(transaction, operations, { cause });
  }

  return new StellarSubmissionUnavailableError(describeSubmissionFailure(cause), { cause });
}

/**
 * A short, non-sensitive classification of a non-rejection failure.
 *
 * A 4xx that is not a transaction failure (a memo-required account, a Horizon that
 * answers a `406`) is reported by status rather than by body: the body is Horizon's
 * prose, it is not a result code the caller can act on, and it is unbounded in
 * length. `NetworkError`'s own `message` is included because for a transport failure
 * it is the only thing that distinguishes a refused socket from a DNS failure, and
 * it contains no transaction data.
 */
function describeSubmissionFailure(cause: unknown): string {
  if (cause instanceof BadResponseError) {
    const status = cause.response?.status;

    return typeof status === 'number'
      ? `Horizon answered HTTP ${status}`
      : 'Horizon answered an unreadable response';
  }

  if (cause instanceof NetworkError) {
    const detail = cause.message.trim();

    return `Horizon did not answer${detail === '' ? '' : ` (${detail})`}`;
  }

  if (cause instanceof Error && cause.message !== '') {
    return `${cause.constructor.name}: ${cause.message}`;
  }

  return 'unknown failure';
}
