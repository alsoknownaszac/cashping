import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { StellarNetwork } from '../../config/validation.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccountResponseDto } from '../dto/account-response.dto.js';
import { BalanceResponseDto } from '../dto/balance-response.dto.js';
import { UsdcTrustlineService } from '../provisioning/usdc-trustline.js';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
} from '../stellar/account-source.js';
import { StellarService } from '../stellar/stellar.service.js';
import { readBalances, type WalletBalances } from './balance-lines.js';

/** What one read of the network produced, before either endpoint's shape is applied. */
interface WalletSnapshot {
  readonly accountId: string;
  readonly publicKey: string;
  readonly createdAt: Date;
  readonly network: StellarNetwork;
  readonly funded: boolean;
  readonly balances: WalletBalances;
}

/**
 * The one message a Horizon that did not answer produces.
 *
 * It says what is *not* known, in the same words a person would need to hear: the balance
 * is unknown, not zero, and trying again is the thing to do. A response that quietly
 * answered `0.0000000` when Horizon was down would be the worst bug this endpoint could
 * have, because it is indistinguishable from a correct answer.
 */
const HORIZON_UNAVAILABLE =
  'The Stellar network could not be reached, so this balance is unknown rather than zero. Try again shortly.';

/**
 * The read side of the wallet (Step 20): what the signed-in user's account is, and what is
 * in it, straight from Horizon.
 *
 * ## Two views, one read
 *
 * `accountFor` and `balanceFor` are the two endpoints, and both are projections of the
 * same question - "what does Horizon say about this account right now" - asked once per
 * request. Keeping the read in one place is what stops the two endpoints from drifting
 * into two different definitions of "funded", and it is why neither of them contains any
 * logic beyond naming its own fields.
 *
 * ## The row says *which* account; Horizon says what is in it
 *
 * The `stellar_accounts` row is the only thing that knows which public key belongs to this
 * user, so it is read first. Everything after that comes from the network: no balance is
 * cached, remembered, or defaulted anywhere in this class, which is the property Step 20's
 * audit checks by comparing this response against a direct Horizon query - a number that
 * agrees with Horizon only because it was copied from Horizon an hour ago would be a
 * different and much weaker claim.
 *
 * ## The four states a request can be in, and why each one is not an error
 *
 * - **No row** → `404`. Reachable only when provisioning failed at its `storage` stage
 *   (Step 19 reports that as `incomplete`), so the client is told plainly that there is no
 *   wallet yet instead of being handed an empty one. Nothing is logged: provisioning
 *   already logged the failure loudly when it happened, and a client polling this endpoint
 *   must not turn that one event into a stream of log lines.
 * - **Row, but the network has never seen the key** → `200` with `funded: false` and both
 *   balances `null`. This is a retryable state, not a client error, and a 404 here would
 *   tell the user their wallet does not exist while the app has their address.
 * - **Row, account funded** → `200` with the numbers Horizon reported.
 * - **Horizon unreachable** → `503`, with a message that says the balance is unknown rather
 *   than zero. `StellarAccountSourceError` is the only failure treated this way: it is the
 *   one that carries no information about the account at all.
 *
 * The distinction between the middle two is why the account source's errors are two types
 * (`account-source.ts` records that reasoning) and why they are unpacked *here* rather than
 * one layer down: this is the only place that also knows whether the user has a wallet row
 * to be talking about.
 */
@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * The single door to the network, so this class never builds a Horizon client and
     * never chooses a network of its own - and never takes the per-account lock, which
     * `loadBalances` explains.
     */
    private readonly stellar: StellarService,
    /**
     * Where "which USDC" comes from, for the same reason the provisioning flow asks it:
     * the asset this deployment is paid in is decided in one place, and a balance endpoint
     * that re-read the config key could answer for a different asset than the trustline
     * that was actually established.
     */
    private readonly trustline: UsdcTrustlineService,
  ) {}

  /**
   * `GET /v1/wallet/account`: the account this user's wallet is, and whether the network
   * knows it yet.
   */
  async accountFor(userId: string): Promise<AccountResponseDto> {
    const snapshot = await this.read(userId);

    return {
      accountId: snapshot.accountId,
      publicKey: snapshot.publicKey,
      network: snapshot.network,
      // ISO-8601, like every other date this API returns: the client should never have to
      // parse two date formats because two endpoints were written a day apart.
      createdAt: snapshot.createdAt.toISOString(),
      funded: snapshot.funded,
      nativeBalance: snapshot.balances.native,
    };
  }

  /**
   * `GET /v1/wallet/balance`: the USDC line, as Horizon reports it, for this call.
   */
  async balanceFor(userId: string): Promise<BalanceResponseDto> {
    const snapshot = await this.read(userId);

    return {
      asset: this.trustline.assetIdentity(),
      balance: snapshot.balances.usdc.balance,
      trustline: snapshot.balances.usdc.status,
      funded: snapshot.funded,
    };
  }

  /**
   * The one read both endpoints are projections of: the row, then the network.
   *
   * Throws `NotFoundException` when there is no wallet to report on and
   * `ServiceUnavailableException` when Horizon did not answer; everything else - including
   * an account the ledger has never seen - is a snapshot with `funded: false` in it.
   */
  private async read(userId: string): Promise<WalletSnapshot> {
    const account = await this.prisma.stellarAccount.findUnique({
      where: { userId },
      // Three columns, because that is all this response needs: the key to ask Horizon
      // about, the id that names the wallet, and when it was created. The envelope and its
      // ARN are deliberately not selected - a balance endpoint has no business loading
      // ciphertext into a process's heap, and not selecting it is how that stays true.
      select: { id: true, publicKey: true, createdAt: true },
    });

    if (account === null) {
      throw new NotFoundException('No Stellar account has been provisioned for this user yet.');
    }

    const network = this.stellar.network();
    const asset = this.trustline.assetIdentity();

    try {
      const lines = await this.stellar.loadBalances(account.publicKey);

      return {
        accountId: account.id,
        publicKey: account.publicKey,
        createdAt: account.createdAt,
        network,
        funded: true,
        balances: readBalances(lines, asset),
      };
    } catch (cause) {
      /**
       * The account does not exist on this network *yet*: the row is ahead of the ledger,
       * because provisioning stopped between sealing the key and funding it. Reported as a
       * 200 with nothing in it rather than as an error, because the wallet the client asked
       * about does exist and the state is one a retry can fix - and `readBalances([])` is
       * exactly that answer, with no special case for it.
       */
      if (cause instanceof StellarAccountNotFoundError) {
        return {
          accountId: account.id,
          publicKey: account.publicKey,
          createdAt: account.createdAt,
          network,
          funded: false,
          balances: readBalances([], asset),
        };
      }

      /**
       * Horizon did not answer. Nothing about the account is known, so nothing about it is
       * said - and the log line names the public key, which is public by construction and
       * is the only way an operator can tell one unreachable account from another.
       */
      if (cause instanceof StellarAccountSourceError) {
        this.logger.warn(
          `Horizon could not report balances for ${account.publicKey}: ${cause.message}`,
        );

        throw new ServiceUnavailableException(HORIZON_UNAVAILABLE);
      }

      // A bug, or a failure no layer classified: it belongs to the global filter, which
      // reports it to Sentry, rather than being reshaped into a balance.
      throw cause;
    }
  }
}
