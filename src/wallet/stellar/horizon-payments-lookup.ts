import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError } from '@stellar/stellar-sdk';
import {
  HORIZON_SERVER_FACTORY,
  type HorizonServer,
  type HorizonServerFactory,
} from './horizon-account-source.js';
import {
  StellarPaymentsLookupError,
  type IncomingPaymentPage,
  type IncomingStellarPayment,
  type StellarPaymentsLookup,
  type StellarPaymentsLookupOptions,
} from './payments-lookup.js';

/**
 * The narrow shape of a payment record this class reads.
 *
 * A local interface rather than the SDK's `ServerApi` union, for the same reason
 * `StellarBalanceLine` is one: the union's other members (`create_account`, `account_merge`,
 * `invoke_host_function`) have no `to` and no `amount`, and this read has to be able to *skip*
 * them rather than fail to represent them. Every field is read off the record Horizon returns
 * (`id`, `paging_token`, `created_at`, `transaction_hash`, `from`, `to`, `amount`, `asset_*`),
 * and `asset_code`/`asset_issuer` are optional because a native payment carries neither.
 */
interface HorizonPaymentRecord {
  readonly id: string;
  readonly paging_token: string;
  readonly created_at: string;
  readonly transaction_hash: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
}

/**
 * Horizon-backed `StellarPaymentsLookup`: one SDK call - `payments().forAccount(id)` - and the
 * mapping of what comes back into the port's shape.
 *
 * `forAccount` returns every operation where the account is *either* party, so the filter to
 * incoming (`to === accountId`) is the whole of "deposits" and is done here rather than in the
 * service: the port promises incoming payments, and a caller should not have to re-derive that
 * from `from`/`to`.
 *
 * `includeFailed` is deliberately not enabled - the same reason `transactions()` is used rather
 * than a raw operations query: Horizon's default is operations of *successful* transactions, and
 * a payment that a ledger refused is not a deposit.
 */
@Injectable()
export class HorizonPaymentsLookup implements StellarPaymentsLookup {
  private server: HorizonServer | undefined;

  constructor(
    private readonly config: ConfigService,
    @Inject(HORIZON_SERVER_FACTORY) private readonly createServer: HorizonServerFactory,
  ) {}

  async listIncoming(
    accountId: string,
    options: StellarPaymentsLookupOptions,
  ): Promise<IncomingPaymentPage> {
    try {
      const builder = this.horizon()
        .payments()
        .forAccount(accountId)
        .order('desc')
        .limit(options.limit);

      const page = await (options.cursor === undefined
        ? builder
        : builder.cursor(options.cursor)
      ).call();

      const payments = page.records.flatMap((record) =>
        isIncomingPayment(record, accountId) ? [toIncomingPayment(record)] : [],
      );

      return { payments, nextCursor: payments.at(-1)?.pagingToken ?? null };
    } catch (cause) {
      /**
       * An account Horizon has never seen is a normal state, not a failure - a freshly funded
       * wallet has no payments yet - so it is the empty answer rather than an error, exactly as
       * `HorizonAccountSource` treats `NotFoundError` for a freshly generated keypair.
       */
      if (cause instanceof NotFoundError) {
        return { payments: [], nextCursor: null };
      }

      throw new StellarPaymentsLookupError(accountId, { cause });
    }
  }

  /**
   * The client, built once on first use from the same factory and the same config key the other
   * three Horizon ports use. A fourth `Horizon.Server` pointing at the same host, for the same
   * deliberate non-sharing: this read is a paged query and wants a client of its own.
   */
  private horizon(): HorizonServer {
    this.server ??= this.createServer(this.config.getOrThrow<string>('stellar.horizonUrl'));

    return this.server;
  }
}

/** Whether one Horizon operation record is a payment *into* `accountId`. */
function isIncomingPayment(record: unknown, accountId: string): record is HorizonPaymentRecord {
  if (typeof record !== 'object' || record === null) {
    return false;
  }

  const candidate = record as Record<string, unknown>;

  // `to` is absent on `create_account`, `account_merge` and `invoke_host_function`, and `amount`
  // is absent on the non-payment operations that do not carry a destination amount - so together
  // the two checks select exactly the `payment` and `path_payment*` records that credited this
  // account. `from` is not filtered on: an account can pay itself, and a refund is a deposit.
  return candidate.to === accountId && typeof candidate.amount === 'string';
}

/** Projects one Horizon payment record onto the port's shape. */
function toIncomingPayment(record: HorizonPaymentRecord): IncomingStellarPayment {
  return {
    id: record.id,
    pagingToken: record.paging_token,
    createdAt: record.created_at,
    transactionHash: record.transaction_hash,
    from: record.from,
    amount: record.amount,
    assetCode: record.asset_code ?? null,
    assetIssuer: record.asset_issuer ?? null,
  };
}
