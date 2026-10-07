import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/http/swagger.js';
import { CurrentUser } from '../identity/jwt/current-user.decorator.js';
import { JwtAuthGuard } from '../identity/jwt/jwt-auth.guard.js';
import { type SessionUser } from '../identity/token/token.service.js';
import { BalancesService } from './balances/balances.service.js';
import { DepositsService } from './deposits/deposits.service.js';
import { AccountResponseDto } from './dto/account-response.dto.js';
import { BalanceResponseDto } from './dto/balance-response.dto.js';
import { DepositListResponseDto } from './dto/deposit-response.dto.js';
import { ListDepositsQueryDto } from './dto/list-deposits.dto.js';

/**
 * The wallet over HTTP (Step 20): `GET /v1/wallet/account` and `GET /v1/wallet/balance`.
 *
 * Two endpoints, one question each. `/account` is *what my wallet is* - the address to be
 * paid at, the network, and whether the network knows it yet - and `/balance` is *what is
 * in it*, which Step 20 defines as the USDC line specifically. Neither is a lookup by
 * user: the account reported is always the caller's own.
 *
 * ## There is no `:userId` in these paths, on purpose
 *
 * A wallet endpoint that took an id would be an endpoint that authorises by convention:
 * whoever holds a token could read any account's balances by guessing a parameter, and the
 * only thing standing between that and a leak would be a check written at the top of a
 * handler. The user comes from `@CurrentUser()`, which the guard has just resolved from the
 * token, so the surface has nothing to enumerate. A future endpoint that legitimately needs
 * another user's wallet (paying them) is a different endpoint, with its own decision about
 * what may be disclosed.
 *
 * ## The guard and the user are identity's, and that is a file, not a module
 *
 * `JwtAuthGuard` and `@CurrentUser` are Step 16's, reused rather than re-implemented: a
 * second guard in this module would be a second definition of what an access token means.
 * What the import is *not* is a module dependency - `WalletModule` deliberately does not
 * import `IdentityModule`, because the dependency runs the other way (identity asks the
 * wallet to provision, in Step 19), and a cycle would be the honest way to describe
 * importing it. Nothing is missing because of that: the guard has no constructor
 * dependencies of its own, and the `jwt` strategy it resolves by name is registered by
 * `IdentityModule` once, in the app graph this controller is served from.
 *
 * ## Every handler is one delegation
 *
 * The same shape `AuthController` uses: the guard establishes that there is a user, the
 * DTOs establish what a response looks like, and `BalancesService` owns the logic and the
 * status codes (`404` for "no wallet yet", `503` for a Horizon that did not answer). Nothing
 * here knows what a Horizon balance line is, which is what keeps "the balance matches
 * Horizon" a statement about one file when it is audited.
 */
@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly balances: BalancesService,
    private readonly deposits: DepositsService,
  ) {}

  @Get('account')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The signed-in user's Stellar account",
    description: [
      'The wallet itself: the address it can be paid at, the network that address is on, and whether the network knows the account yet.',
      '',
      '`funded: false` means provisioning did not get past funding - the account row exists and the funding step can be retried, but nothing about the wallet is on the ledger yet, so every balance is `null` rather than `0`. A client should show "setting up" for that state, not an empty wallet.',
      '',
      'The `publicKey` is the only field here that is safe to share: it is what a payer needs. Nothing in this response can be used to spend.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: AccountResponseDto,
    description: 'The wallet, and whether the network has seen it yet.',
  })
  @ApiErrorResponses([
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    {
      status: 403,
      description: 'The account is suspended.',
    },
    {
      status: 404,
      description:
        'No Stellar account has been provisioned for this user, so there is no wallet to report on.',
    },
    {
      status: 503,
      description:
        'Horizon could not be reached, so whether the account is funded is unknown. Nothing about the wallet is being reported - retry shortly.',
    },
  ])
  account(@CurrentUser() user: SessionUser): Promise<AccountResponseDto> {
    return this.balances.accountFor(user.id);
  }

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The signed-in user's USDC balance",
    description: [
      "The USDC line of the caller's own account, queried from Horizon on this request - it is a reading, not a cached or defaulted value.",
      '',
      '`balance` is Horizon\'s own decimal string, unmodified: 7 decimal places, and no rounding anywhere in between. `null` means there is no USDC line to read a balance from, which `trustline` distinguishes from an empty one - `0.0000000` with `trustline: "active"` is an empty wallet, `trustline: "missing"` is a wallet that cannot be paid at all, and `trustline: "unauthorized"` is one whose line the issuer has not approved (payments to it are rejected at the sender).',
      '',
      '`asset.issuer` is part of the answer rather than a detail: `USDC` from a different issuer is a different asset that happens to share a code, and this is the issuer the wallet actually trusts.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: BalanceResponseDto,
    description: 'The USDC line, as Horizon reports it for this call.',
  })
  @ApiErrorResponses([
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    {
      status: 403,
      description: 'The account is suspended.',
    },
    {
      status: 404,
      description:
        'No Stellar account has been provisioned for this user, so there is no balance to report.',
    },
    {
      status: 503,
      description:
        'Horizon could not be reached, so the balance is unknown rather than zero. Retry shortly.',
    },
  ])
  balance(@CurrentUser() user: SessionUser): Promise<BalanceResponseDto> {
    return this.balances.balanceFor(user.id);
  }

  @Get('deposits')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Money paid into your wallet',
    description: [
      "The USDC payments Horizon reports arriving at the caller's own Stellar account, newest first - read from the network on this request, exactly like `/balance`, and never from a stored copy.",
      '',
      '`items` is a page ordered by Horizon, and `nextCursor` is the token for the page after it: pass it back as `?cursor=` to walk to older deposits. `null` means this was the last page. `limit` defaults to 20 and is capped at 50.',
      '',
      "Only this deployment's USDC is reported - a payment in another asset (XLM, or `USDC` from a different issuer) is not money the product moves and is filtered out. `from` is the sender's Stellar account, which may not be a CashPing user.",
    ].join('\n'),
  })
  @ApiOkResponse({
    type: DepositListResponseDto,
    description: 'One page of incoming USDC, newest first.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: '`limit` is not a whole number, or `cursor` was sent empty.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 404,
      description:
        'No Stellar account has been provisioned for this user, so there is no wallet to report deposits for.',
    },
    {
      status: 503,
      description:
        'Horizon could not be reached, so the deposits are unknown rather than empty. Retry shortly.',
    },
  ])
  listDeposits(
    @CurrentUser() user: SessionUser,
    @Query() query: ListDepositsQueryDto,
  ): Promise<DepositListResponseDto> {
    return this.deposits.listFor(user.id, query);
  }
}
