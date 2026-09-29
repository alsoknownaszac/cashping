import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BalancesService } from './balances/balances.service.js';
import { KEY_WRAPPER } from './custody/key-wrapper.js';
import { KMS_CLIENT_FACTORY, KmsKeyWrapper, createKmsClient } from './custody/kms-key-wrapper.js';
import { SeedCustodyService } from './custody/seed-custody.service.js';
import { ACCOUNT_FUNDER } from './provisioning/account-funder.js';
import { AccountProvisioningService } from './provisioning/account-provisioning.service.js';
import { FriendbotFunder } from './provisioning/friendbot-funder.js';
import { UsdcTrustlineService } from './provisioning/usdc-trustline.js';
import { STELLAR_ACCOUNT_SOURCE } from './stellar/account-source.js';
import {
  HORIZON_SERVER_FACTORY,
  HorizonAccountSource,
  createHorizonServer,
} from './stellar/horizon-account-source.js';
import { HorizonTransactionSubmitter } from './stellar/horizon-transaction-submitter.js';
import { StellarService } from './stellar/stellar.service.js';
import { STELLAR_TRANSACTION_SUBMITTER } from './stellar/transaction-submitter.js';
import { WalletController } from './wallet.controller.js';

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
 * Step 18 adds three providers on the same pattern, for key material rather than
 * sequence numbers:
 *
 * - `KEY_WRAPPER` is the port `SeedCustodyService` depends on, bound here to
 *   `KmsKeyWrapper`. That binding is the only place AWS enters the wallet module.
 * - `KMS_CLIENT_FACTORY` is bound to the real SDK constructor and to an injected
 *   fake in `KmsKeyWrapper`'s spec, so every branch of the KMS error mapping is
 *   testable without a network - the same reason `HORIZON_SERVER_FACTORY` exists.
 * - `SeedCustodyService` is the API Step 19 calls. Nothing outside this module imports
 *   it - the provisioning flow is *in* this module - so it is still not exported.
 *
 * Step 19 adds four providers, and the shape of the step is visible in which of them
 * are tokens:
 *
 * - `STELLAR_TRANSACTION_SUBMITTER` is a token because the funder question and the
 *   submitter question have the same answer: *where the network is* is a deployment
 *   fact (Testnet, a local node, mainnet), and the unit specs of everything above this
 *   line need a Horizon that answers in microseconds rather than one that is on the
 *   other side of an undici socket. `StellarService` owns both ports, so the rest of
 *   the app never learns whether they point at the same host.
 * - `ACCOUNT_FUNDER` is the seam the build sequence names for staging: a treasury
 *   account that the operator funds binds here instead of friendbot, and nothing else
 *   in provisioning changes. It is *this* module's boundary rather than config's,
 *   because a treasury funder has a key to sign with and so belongs behind custody,
 *   not behind an environment variable.
 * - `FriendbotFunder` and `UsdcTrustlineService` are concrete: a funder bound to
 *   `ACCOUNT_FUNDER` is a *choice*, and the only friendbot is friendbot. A deployment
 *   that wants a treasury binds a different class to the same token.
 * - `AccountProvisioningService` is the step's API and is exported, because the
 *   consumer is `IdentityModule` - `verifyOtp` is what triggers provisioning, and
 *   registration completion is the only event that can. Nothing else may import it
 *   yet: a second caller is a second policy about when accounts are created.
 *
 * Step 19 also made this the first module outside identity to talk to the database, which is
 * why `PrismaModule` is in the `imports` below: `AccountProvisioningService` reads the user's
 * verification, inserts the `stellar_accounts` row for the new key and re-reads that row after
 * a lost race, and a provider can only inject what the module that *declares* it imports.
 * `PrismaModule` is deliberately not `@Global()` - its own docstring records that which modules
 * talk to the database is worth keeping in the graph - so the alternative, reaching the client
 * from a global, would have compiled and left the graph saying that nothing outside identity
 * touches a table. `WalletModule` importing `PrismaModule` is the same statement `IdentityModule`
 * makes, made by the second module that needs it.
 *
 * Keypair custody (Step 18), provisioning (19) and balances (20) add their own
 * providers here. `StellarService` is deliberately *not* exported yet: nothing
 * outside this module injects it, and an export nothing imports is a guess about
 * the future rather than a boundary - the same reasoning `IdentityModule` records.
 * The export arrives with the first consumer outside this module, which is
 * `PaymentsModule` in Step 23.
 *
 * Step 20 adds the module's first `controllers` entry, and `BalancesService` beside it:
 *
 * - `WalletController` is where the wallet becomes HTTP (`GET /v1/wallet/account`,
 *   `GET /v1/wallet/balance`). It is registered here rather than in `IdentityModule`
 *   because the endpoints are the wallet's own subject, and because a controller is
 *   part of a module's public surface - the module that owns the data owns the routes.
 *   It reads identity's `JwtAuthGuard` and `@CurrentUser` as a *file* import; see its
 *   docstring for why that is not a module dependency, and why importing
 *   `IdentityModule` here would be a cycle rather than a fix.
 * - `BalancesService` is not exported and has no token: nothing substitutes it, because
 *   what it does is read - the interesting seams (the account source, the network) are
 *   already below it, and a fake above them would only be able to prove that a fake was
 *   called. Its own spec substitutes `StellarService` and the account source instead,
 *   which are the two things Step 20's audit is really about.
 *
 * `WalletModule` now serves both of the ways a wallet is reached - the trigger that
 * provisions one (an exported provider, injected by identity) and the endpoints that
 * report on one (a controller, reached by HTTP) - and `StellarService` is still not
 * exported, which is the boundary holding: `BalancesService` uses it internally, and
 * `PaymentsModule` will be the first module allowed to.
 */
@Module({
  /** The `stellar_accounts` table, and nothing else: see the docstring above. */
  imports: [PrismaModule],
  controllers: [WalletController],
  providers: [
    StellarService,
    { provide: STELLAR_ACCOUNT_SOURCE, useClass: HorizonAccountSource },
    { provide: HORIZON_SERVER_FACTORY, useValue: createHorizonServer },
    { provide: STELLAR_TRANSACTION_SUBMITTER, useClass: HorizonTransactionSubmitter },
    SeedCustodyService,
    { provide: KEY_WRAPPER, useClass: KmsKeyWrapper },
    { provide: KMS_CLIENT_FACTORY, useValue: createKmsClient },
    UsdcTrustlineService,
    { provide: ACCOUNT_FUNDER, useClass: FriendbotFunder },
    AccountProvisioningService,
    BalancesService,
  ],
  // `verifyOtp` is the only consumer, and it is in `IdentityModule`.
  exports: [AccountProvisioningService],
})
export class WalletModule {}
