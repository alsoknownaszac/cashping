import { ApiProperty } from '@nestjs/swagger';
import { WalletAssetDto } from './balance-response.dto.js';

/**
 * One deposit: a payment Horizon saw arrive at the caller's account.
 *
 * Deliberately narrower than `PaymentListItemDto`, because the two lists have different sources
 * and only one of them is this app's. A payments-history row is a transaction this app created
 * and knows both parties of; a deposit is money the *ledger* says arrived, which may have come
 * from a wallet this app has never seen and whose counterparty it therefore cannot name. So
 * there is no `id` to poll (`GET /v1/payments/:id` only answers for rows this app wrote), no
 * `direction` (every item is incoming, by construction), and no `counterparty` handle - just the
 * facts the ledger carries.
 *
 * The amount is Horizon's decimal string, unmodified, for the reason every money field in this
 * API is: 7-decimal fixed point does not survive a double, and a deposit is the last place to
 * start rounding.
 */
export class DepositItemDto {
  @ApiProperty({
    description: 'Horizon’s operation id for this payment.',
    example: '128849018881',
  })
  id!: string;

  @ApiProperty({
    description: 'The amount received, as Horizon reports it (7 decimal places, unmodified).',
    example: '25.0000000',
    type: String,
  })
  amount!: string;

  @ApiProperty({
    description:
      'The Stellar account the money came from, in `G…` form. Not resolved to a CashPing handle: a deposit can arrive from an account this app has never seen, so there is often nothing to resolve it to.',
    example: 'GDHU2YQBJ4O3G6FQMVBBMGX7RB6XQW6QMVBBMGX7RB6XQW6QMVBBMGX7RB6',
  })
  from!: string;

  @ApiProperty({
    description: 'When the ledger that carries the payment closed, as an ISO-8601 instant.',
    example: '2026-10-05T09:14:03Z',
  })
  createdAt!: string;

  @ApiProperty({
    description:
      'The hash of the Stellar transaction the payment was part of. Paste it into an explorer to see it for yourself.',
    example: 'e9da1c48bdfaeacd13eb05d1fff82eee4d61d77f0faa467c9d539955bf36ec0d',
  })
  transactionHash!: string;
}

/**
 * 200 body of `GET /v1/wallet/deposits`: one page of incoming USDC, newest first.
 *
 * `asset` is stated once for the whole page rather than on every item, because this endpoint
 * reports *this deployment's* USDC and nothing else - the same (code, issuer) pair
 * `GET /v1/wallet/balance` returns, read from the same service. Native payments (XLM) and
 * payments in any other asset are filtered out before the map, so a caller never has to check
 * per row whether the money is the money the product moves; the one asset the endpoint can
 * answer about is named at the top.
 *
 * `nextCursor` is Horizon's paging token for the last deposit in the page, or `null` when this
 * was the final page. Pass it back as `?cursor=` to fetch older deposits - it is Horizon's own
 * token, so paging stays correct when a new deposit lands between two calls.
 */
export class DepositListResponseDto {
  @ApiProperty({
    description:
      'Which asset every item in this page is of. `USDC` from the issuer this deployment is configured with.',
    type: WalletAssetDto,
  })
  asset!: WalletAssetDto;

  @ApiProperty({
    description: 'The deposits that matched, newest first.',
    type: [DepositItemDto],
  })
  items!: DepositItemDto[];

  @ApiProperty({
    description:
      'The `cursor` for the next (older) page, or `null` when this page was the last. Pass it back as the `cursor` query parameter.',
    nullable: true,
    type: String,
    example: '128849018880',
  })
  nextCursor!: string | null;
}
