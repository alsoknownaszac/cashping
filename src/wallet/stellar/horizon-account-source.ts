import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, NotFoundError, type TransactionSource } from '@stellar/stellar-sdk';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
  type StellarAccountSource,
} from './account-source.js';
import { horizonServerOptions } from './stellar-network.js';

/**
 * The Horizon client this source talks to.
 *
 * `Horizon.Server` is a class from the SDK; the type is derived from it rather
 * than re-declared so the two cannot drift.
 */
export type HorizonServer = InstanceType<typeof Horizon.Server>;

export type HorizonServerFactory = (url: string) => HorizonServer;

/**
 * The seam `HorizonAccountSource`'s spec substitutes to test against a fake
 * Horizon. Production binds the real constructor below, in `WalletModule`.
 */
export const HORIZON_SERVER_FACTORY = Symbol('HORIZON_SERVER_FACTORY');

/**
 * Builds the real client. `horizonServerOptions` is what decides whether plain
 * http is acceptable for the configured host (loopback only), so this is also the
 * single place that policy is applied.
 */
export const createHorizonServer: HorizonServerFactory = (url) =>
  new Horizon.Server(url, horizonServerOptions(url));

/**
 * Horizon-backed `StellarAccountSource` (Step 17).
 *
 * The only behaviour here is turning the SDK's failures into the two errors the
 * rest of the app reasons about, since "this account does not exist" (a normal
 * state for a freshly generated keypair) and "Horizon did not answer" (retry, and
 * claim nothing) call for opposite reactions.
 *
 * No logging: the account id is not a secret, but the failure paths here are all
 * about money-adjacent state, and Steps 19-20 decide what an operator should see
 * when one of them fires. Until then the error travels to the caller with its
 * `cause` intact.
 */
@Injectable()
export class HorizonAccountSource implements StellarAccountSource {
  private server: HorizonServer | undefined;

  constructor(
    private readonly config: ConfigService,
    @Inject(HORIZON_SERVER_FACTORY) private readonly createServer: HorizonServerFactory,
  ) {}

  async loadAccount(accountId: string): Promise<TransactionSource> {
    try {
      // Construction is inside the `try` on purpose: an endpoint the SDK refuses
      // (plain http off loopback, say) surfaces here, and it should read as "this
      // source could not load the account", not as a raw SDK error from a
      // different layer.
      return await this.horizon().loadAccount(accountId);
    } catch (cause) {
      if (cause instanceof NotFoundError) {
        throw new StellarAccountNotFoundError(accountId, { cause });
      }

      throw new StellarAccountSourceError(accountId, { cause });
    }
  }

  /**
   * The client, built once on first use.
   *
   * A `Horizon.Server` carries its own configuration, so building one per call
   * would throw that away and re-create it on every account load. When the
   * configured fallback host is actually used as a fallback, it is a second
   * instance created the same way - the slot exists in `StellarService` already,
   * and nothing selects it yet.
   */
  private horizon(): HorizonServer {
    this.server ??= this.createServer(this.config.getOrThrow<string>('stellar.horizonUrl'));

    return this.server;
  }
}
