import { Module } from '@nestjs/common';
import { STELLAR_ACCOUNT_SOURCE } from './stellar/account-source.js';
import {
  HORIZON_SERVER_FACTORY,
  HorizonAccountSource,
  createHorizonServer,
} from './stellar/horizon-account-source.js';
import { StellarService } from './stellar/stellar.service.js';

/**
 * Wallet bounded context (Stellar account custody, signing, balances).
 *
 * What is here as of Step 17 is the network-facing half: `StellarService`, the
 * per-source-account sequence-number queue it owns, and the Horizon-backed account
 * source behind `STELLAR_ACCOUNT_SOURCE`. Two of the three providers exist to be
 * *swappable*:
 *
 * - `STELLAR_ACCOUNT_SOURCE` is a token rather than a class because that is the
 *   seam a cached or failover source binds to, and because the unit tests
 *   substitute a Horizon that models sequence numbers instead of calling the real
 *   network (the Step 17 race spec is the reason that matters).
 * - `HORIZON_SERVER_FACTORY` is bound to the SDK constructor here and to a fake in
 *   `HorizonAccountSource`'s spec, so its error mapping is testable offline.
 *
 * Keypair custody (Step 18), provisioning (19) and balances (20) add their own
 * providers here. `StellarService` is deliberately *not* exported yet: nothing
 * outside this module injects it, and an export nothing imports is a guess about
 * the future rather than a boundary - the same reasoning `IdentityModule` records.
 * The export arrives with the first consumer outside this module, which is
 * `PaymentsModule` in Step 23.
 */
@Module({
  providers: [
    StellarService,
    { provide: STELLAR_ACCOUNT_SOURCE, useClass: HorizonAccountSource },
    { provide: HORIZON_SERVER_FACTORY, useValue: createHorizonServer },
  ],
})
export class WalletModule {}
