import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DepositItemDto, DepositListResponseDto } from '../dto/deposit-response.dto.js';
import { UsdcTrustlineService, type UsdcAssetIdentity } from '../provisioning/usdc-trustline.js';
import {
  StellarPaymentsLookupError,
  type IncomingStellarPayment,
} from '../stellar/payments-lookup.js';
import { StellarService } from '../stellar/stellar.service.js';
import {
  InvalidDepositQueryError,
  invalidDepositQueryMessage,
  parseDepositQuery,
  type DepositQuery,
  type RawDepositQuery,
} from './deposit-query.js';

/**
 * The one message a Horizon that did not answer produces, in the words a person needs: the
 * deposits are unknown, not absent, and trying again is the thing to do. A response that quietly
 * answered an empty list when Horizon was down would be indistinguishable from "nothing was ever
 * paid in", which is the worst bug this endpoint could have.
 */
const HORIZON_UNAVAILABLE =
  'The Stellar network could not be reached, so your deposits are unknown rather than empty. Try again shortly.';

/**
 * The deposits read (`GET /v1/wallet/deposits`): what Horizon says was paid into the caller's
 * own account.
 *
 * ## The row says *which* account; Horizon says what arrived
 *
 * The same division `BalancesService` makes, for the same reason: the `stellar_accounts` row is
 * the only thing that knows which public key belongs to this user, so it is read first, and
 * everything after that - the deposits - comes from the ledger. Nothing is cached or stored: a
 * deposit is a fact about a closed ledger, and a second copy would be a second answer.
 *
 * ## USDC only, and the filter is the asset identity
 *
 * The product money is this deployment's USDC, so the page is filtered to it, by *code and
 * issuer* - the same comparison `readBalances` and `UsdcTrustlineService.isUsdcLine` make,
 * because `USDC` from another issuer is another asset. Native payments (XLM) and any other asset
 * are dropped: they are not deposits the product can act on, and reporting them would make a
 * client decide, row by row, whether the money is the money.
 *
 * ## A payment this app moved is not also a deposit
 *
 * A Cashping-to-Cashping transfer *is* a real Stellar payment, so Horizon reports it arriving at
 * the recipient's account - and the recipient already has it on `GET /v1/payments` as a received
 * payment, named by the sender's handle and dated from the same ledger. Left alone, the app would
 * count that money twice on two screens a client reads side by side. So a deposit whose
 * transaction hash this app recorded creating for the caller is suppressed here: what is left is
 * money that arrived from *outside*, which is exactly the money this endpoint has no counterparty
 * to name and `GET /v1/payments` cannot show.
 *
 * The hash is the join, and it is exact. `transactions.stellar_tx_hash` is written before the
 * signed transaction is handed to Horizon and is unique, so it identifies one transaction the app
 * built - a transfer the app did not create has no row to match and is never suppressed.
 *
 * ## The three states, and why none is an error
 *
 * - **No row** -> `404`. The same "no wallet yet" answer `BalancesService` gives; the client is
 *   told there is nothing to report on rather than handed an empty list.
 * - **Row, no deposits** -> `200` with `items: []`. A wallet that has been funded but never paid
 *   into, and one not on the ledger yet, both answer this, which is correct: neither has a
 *   deposit to show.
 * - **Horizon unreachable** -> `503`, with a message that says the deposits are unknown rather
 *   than empty.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly trustline: UsdcTrustlineService,
  ) {}

  /** One page of the caller's incoming USDC, newest first. */
  async listFor(userId: string, raw: RawDepositQuery): Promise<DepositListResponseDto> {
    const query = this.parse(raw);
    const asset = this.trustline.assetIdentity();

    const account = await this.prisma.stellarAccount.findUnique({
      where: { userId },
      // One column, for the same reason `BalancesService.read` selects three and not the
      // envelope: asking Horizon about a key needs the key, and nothing about a deposit endpoint
      // has any business loading ciphertext into the process's heap.
      select: { publicKey: true },
    });

    if (account === null) {
      throw new NotFoundException('No Stellar account has been provisioned for this user yet.');
    }

    const page = await this.read(account.publicKey, query);

    const deposits = page.payments.filter((payment) => isAsset(payment, asset));
    const recorded = await this.recordedHashes(userId, deposits);

    return {
      asset,
      items: deposits.filter((payment) => !recorded.has(payment.transactionHash)).map(toItem),
      // Horizon's own cursor, taken *before* the suppression above: paging follows the ledger page,
      // not the visible rows, so a suppressed deposit is neither fetched again on the next call nor
      // able to shift a newer one out of view.
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Reads the query, or answers 400 naming the parameter that could not be read. The parse lives
   * in `deposit-query.ts`; this is only the HTTP mapping, the same split the payments history
   * makes.
   */
  private parse(raw: RawDepositQuery): DepositQuery {
    try {
      return parseDepositQuery(raw);
    } catch (error) {
      if (error instanceof InvalidDepositQueryError) {
        throw new BadRequestException(invalidDepositQueryMessage(error.problem));
      }

      throw error;
    }
  }

  /**
   * Asks Horizon for the page, or answers 503 when it did not answer.
   *
   * A `503` rather than a rethrow, so the failure reaches the client as "we could not check"
   * instead of the global filter's generic 500 - which is the honest distinction the whole
   * `StellarPaymentsLookupError` exists to draw. Anything that is *not* that error is a bug and
   * belongs to the global filter.
   */
  private async read(
    publicKey: string,
    query: DepositQuery,
  ): Promise<Awaited<ReturnType<StellarService['listIncomingPayments']>>> {
    try {
      return await this.stellar.listIncomingPayments(publicKey, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    } catch (cause) {
      if (cause instanceof StellarPaymentsLookupError) {
        throw new ServiceUnavailableException(HORIZON_UNAVAILABLE);
      }

      throw cause;
    }
  }

  /**
   * The hashes on this page that this app is the one that moved the money for.
   *
   * The set of `transactions.stellar_tx_hash` values among `deposits`' hashes that belong to a
   * payment this app recorded *for the caller*. Those are the incoming payments that are already
   * on `GET /v1/payments` for the same user, so they are the ones this endpoint suppresses: an
   * internal transfer is a received payment, and the history endpoint is where a received payment
   * is reported.
   *
   * Scoping the query to the caller is what makes that an argument rather than a coincidence: a
   * row is only suppressed because the caller is one of its two parties, which is the reason the
   * caller can already see it elsewhere. Only the hashes that survived the asset filter are asked
   * about, because a native or foreign-asset payment is being dropped anyway and is not worth a
   * row, and the `in` list is bounded by the page size - at most one page's worth of hashes, on the
   * unique index, per request.
   */
  private async recordedHashes(
    userId: string,
    deposits: readonly IncomingStellarPayment[],
  ): Promise<ReadonlySet<string>> {
    if (deposits.length === 0) {
      return new Set();
    }

    const rows = await this.prisma.transaction.findMany({
      where: {
        stellarTxHash: { in: deposits.map((payment) => payment.transactionHash) },
        OR: [{ senderId: userId }, { recipientId: userId }],
      },
      select: { stellarTxHash: true },
    });

    // The column is nullable in the schema, so the guard is for the type rather than for a case
    // that can reach here: a row selected by `stellarTxHash: { in: [...] }` always has one.
    return new Set(rows.flatMap((row) => (row.stellarTxHash === null ? [] : [row.stellarTxHash])));
  }
}

/** Whether one incoming payment is this deployment's USDC - code *and* issuer, never code alone. */
function isAsset(payment: IncomingStellarPayment, asset: UsdcAssetIdentity): boolean {
  return payment.assetCode === asset.code && payment.assetIssuer === asset.issuer;
}

/** Projects one ledger payment onto the body, reading only the fields the ledger carries. */
function toItem(payment: IncomingStellarPayment): DepositItemDto {
  return {
    id: payment.id,
    amount: payment.amount,
    from: payment.from,
    createdAt: payment.createdAt,
    transactionHash: payment.transactionHash,
  };
}
