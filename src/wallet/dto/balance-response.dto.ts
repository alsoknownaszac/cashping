import { ApiProperty } from '@nestjs/swagger';
import { TRUSTLINE_STATUSES, type TrustlineStatus } from '../balances/balance-lines.js';

/**
 * Which USDC, when a body has to say: the (code, issuer) pair that is an asset's whole
 * identity on Stellar.
 *
 * The issuer is in the response for the same reason it is in configuration - `USDC` from
 * another issuer is another asset - and it is what lets an auditor compare this body with
 * the Horizon line it came from without trusting that the server meant the same thing.
 */
export class WalletAssetDto {
  @ApiProperty({
    description: 'The asset code, as Horizon reports it.',
    example: 'USDC',
  })
  code!: string;

  @ApiProperty({
    description: "The issuing account. On Testnet this is Circle's Testnet issuer.",
    example: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  })
  issuer!: string;
}

/**
 * 200 body of `GET /v1/wallet/balance` (Step 20): the USDC line, and nothing else.
 *
 * Built from a Horizon query for the signed-in user's own account on every call, so it is
 * a reading rather than a cache - which is the property Step 20's audit checks by comparing
 * it against Horizon for the same account.
 *
 * `balance` is Horizon's decimal string, returned as a string: the app never converts a
 * balance to a number, because 7-decimal fixed point does not survive a double and a money
 * endpoint that rounds is worse than one that is a little harder to consume. `null` means
 * there is no line to read a balance from - see `trustline`.
 *
 * `trustline` is the field that makes the number interpretable, and it exists because
 * `0.0000000` has three different meanings: an empty wallet (`active`), a wallet nothing
 * can be paid into yet (`unauthorized`), and a wallet with no line at all (`missing`).
 * Only the first is a balance; the other two are states to do something about, and a
 * response that reported just the number would collapse them into one.
 *
 * `funded` repeats what `GET /v1/wallet/account` reports, on purpose: a client that polls
 * only this endpoint has no other way to tell "no money yet" from "the account is not on
 * the ledger yet", and that difference is exactly the one this endpoint must not guess at.
 */
export class BalanceResponseDto {
  @ApiProperty({
    description:
      'Which asset this balance is of. `USDC` from the issuer this deployment is configured with.',
    type: WalletAssetDto,
  })
  asset!: WalletAssetDto;

  @ApiProperty({
    description:
      'The USDC balance, as Horizon reports it (7 decimal places, unmodified). `null` when there is no USDC line, which `trustline` distinguishes from an empty one.',
    example: '0.0000000',
    nullable: true,
    type: String,
  })
  balance!: string | null;

  @ApiProperty({
    description:
      '`active` (the line exists and is authorised), `unauthorized` (the line exists but the issuer has not authorised it, so payments to this wallet are rejected at the sender), or `missing` (no line, so no USDC can arrive).',
    enum: TRUSTLINE_STATUSES,
    example: 'active',
  })
  trustline!: TrustlineStatus;

  @ApiProperty({
    description:
      'Whether the network knows this account at all. `false` means provisioning did not get past funding, and `balance` is `null` because there is nothing to read it from.',
    example: true,
  })
  funded!: boolean;
}
