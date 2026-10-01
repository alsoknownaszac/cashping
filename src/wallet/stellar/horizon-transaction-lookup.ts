import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError, xdr } from '@stellar/stellar-sdk';
import {
  HORIZON_SERVER_FACTORY,
  type HorizonServer,
  type HorizonServerFactory,
} from './horizon-account-source.js';
import {
  type StellarTransactionLookup,
  type TransactionLookupResult,
} from './transaction-lookup.js';

/**
 * Horizon-backed `StellarTransactionLookup` (Step 28).
 *
 * One SDK call - `transactions().transaction(hash)` - and the mapping of what comes back into the
 * port's three answers. The mapping is the whole of this class, and it is worth having in one
 * place for the same reason the submitter's is: `NotFoundError` is a *normal* answer (a hash
 * Horizon has not ingested, or never will), while every other failure means "we could not ask",
 * and a caller that confused the two would fail payments that landed.
 *
 * The record's `result_xdr` is decoded for the transaction-level code only. Horizon's own
 * `result_codes` field exists on a *submission* failure (an HTTP 400 body, which
 * `TransactionFailedError` carries) and is not part of the fetched record - verified against a
 * real failed Testnet transaction, whose record has `successful: false`, `result_xdr` and no
 * `result_codes`. Reproducing Horizon's normalisation of operation-level codes from the XDR would
 * be a second implementation of its vocabulary; the transaction-level code (`tx_failed`) plus the
 * ledger is what an operator needs, and the reason is stored and rendered.
 */
@Injectable()
export class HorizonTransactionLookup implements StellarTransactionLookup {
  private server: HorizonServer | undefined;

  constructor(
    private readonly config: ConfigService,
    @Inject(HORIZON_SERVER_FACTORY) private readonly createServer: HorizonServerFactory,
  ) {}

  async lookup(hash: string): Promise<TransactionLookupResult> {
    try {
      const record = await this.horizon().transactions().transaction(hash).call();

      return {
        kind: 'settled',
        ledger: record.ledger_attr,
        successful: record.successful,
        transactionCode: transactionCodeOf(record.result_xdr),
      };
    } catch (cause) {
      if (cause instanceof NotFoundError) {
        return { kind: 'not-found' };
      }

      return { kind: 'unavailable', detail: describeLookupFailure(cause) };
    }
  }

  /**
   * The client, built once on first use from the same factory and the same config key
   * `HorizonAccountSource` and `HorizonTransactionSubmitter` use.
   *
   * A third `Horizon.Server` pointing at the same host is the same deliberate non-sharing as
   * between those two: a server object is a URL plus a mutable HTTP client, and the three
   * callers want different timeouts and retry behaviour from theirs.
   */
  private horizon(): HorizonServer {
    this.server ??= this.createServer(this.config.getOrThrow<string>('stellar.horizonUrl'));

    return this.server;
  }
}

/**
 * The transaction-level result code from a result XDR, or `null` if it cannot be read.
 *
 * `null` rather than a throw, deliberately: this is commentary on a fact that has already been
 * established (`successful`), so a shape this SDK version spells differently must not turn a
 * *resolution* into a retry. The failure to read it is worth nothing but a `null` in the column
 * - "the ledger refused it" is still exactly what the reason says without the code.
 *
 * The SDK decodes the union to a variant object whose `type` is the variant's name
 * (`txFailed`), which is Horizon's own code with the underscores removed - verified against a
 * real failed Testnet transaction, whose record decodes to `txFailed`, `tx_too_late`'s shape
 * being the same one with a different name.
 */
export function transactionCodeOf(resultXdr: string): string | null {
  try {
    const decoded = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    const name = String(decoded.result.type);

    return name === '' ? null : snakeCase(name);
  } catch {
    return null;
  }
}

/** `txFailed` -> `tx_failed`, `txBadMinSeqAgeOrGap` -> `tx_bad_min_seq_age_or_gap`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * A short, non-sensitive classification of a lookup Horizon could not answer.
 *
 * The same vocabulary `horizon-transaction-submitter.ts` uses, and for the same reason: the
 * SDK's own messages carry a full URL and sometimes a whole response body, and this text ends up
 * in logs. A 4xx that is not a `NotFound` is reported by status rather than by body.
 */
function describeLookupFailure(cause: unknown): string {
  const response = (cause as { response?: { status?: unknown } } | undefined)?.response;
  const status = response?.status;

  if (typeof status === 'number') {
    return `Horizon answered HTTP ${status}`;
  }

  if (cause instanceof Error && cause.message.trim() !== '') {
    return `Horizon did not answer (${cause.message.trim()})`;
  }

  return 'unknown failure';
}
