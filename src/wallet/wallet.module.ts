import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BalancesService } from './balances/balances.service.js';
import { AuditedKeyWrapper } from './custody/audited-key-wrapper.js';
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
import { HorizonTransactionLookup } from './stellar/horizon-transaction-lookup.js';
import { StellarService } from './stellar/stellar.service.js';
import { STELLAR_TRANSACTION_SUBMITTER } from './stellar/transaction-submitter.js';
import { STELLAR_TRANSACTION_LOOKUP } from './stellar/transaction-lookup.js';
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
 *
 * Step 32 rebinds `KEY_WRAPPER` to a *decorator* over that implementation, and the shape of the
 * change is the argument for it: `KmsKeyWrapper` stays the only file in the app that knows AWS,
 * `SeedCustodyService` stays a class that holds no database handle, and the one place both facts
 * are visible together is the binding below. `AuditedKeyWrapper`'s docstring records why the
 * alternative - a call to `AuditService` inside either of those two classes - would have been
 * worse.
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
 * The export arrives with the first consumer outside this module, which is Step 27's
 * submission job - a signed transaction needs the account lock and the network.
 *
 * Step 25 exports `BalancesService`, which is that boundary arriving for the *read*
 * half instead: `PaymentsService` has to know what the sender's wallet holds before it
 * may write a `PENDING` payment, and it asks the module that owns that question rather
 * than reading `stellar_accounts` and Horizon itself. The alternative - a second "what
 * does this wallet hold" implementation in `payments/` - would be a second place for
 * Step 20's decisions (unfunded, no trustline, Horizon silent) to be got wrong.
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
  /**
   * The one table this context owns and the one it only writes to: see the docstring above for why
   * `AuditModule` is here despite being nothing like the other.
   */
  imports: [AuditModule, PrismaModule],
  controllers: [WalletController],
  providers: [
    StellarService,
    { provide: STELLAR_ACCOUNT_SOURCE, useClass: HorizonAccountSource },
    { provide: HORIZON_SERVER_FACTORY, useValue: createHorizonServer },
    { provide: STELLAR_TRANSACTION_SUBMITTER, useClass: HorizonTransactionSubmitter },
    /**
     * Step 28's third Horizon port. A token for the same reason as the submitter's: the fake the
     * confirmation service's unit spec and `test/submission.e2e-spec.ts` hang off it is what lets
     * the poller's three answers be exercised without the network, while `StellarService` stays
     * the only thing in the app that knows a `Horizon.Server` exists.
     */
    { provide: STELLAR_TRANSACTION_LOOKUP, useClass: HorizonTransactionLookup },
    SeedCustodyService,
    /**
     * Two providers where Step 18 had one, and the split *is* the audit.
     *
     * The concrete wrapper became a dependency of the binding rather than the binding itself, which
     * is what lets `AuditedKeyWrapper` take it. `useFactory` rather than `useClass` because the
     * decorator takes `AuditService` from outside this context, and naming both `inject` entries
     * here keeps "which class talks to KMS" and "what is audited" one line apart - so a reader who
     * wants to know whether custody events reach the audit table has exactly one place to look.
     */
    KmsKeyWrapper,
    {
      provide: KEY_WRAPPER,
      useFactory: (inner: KmsKeyWrapper, audit: AuditService) =>
        new AuditedKeyWrapper(inner, audit),
      inject: [KmsKeyWrapper, AuditService],
    },
    { provide: KMS_CLIENT_FACTORY, useValue: createKmsClient },
    UsdcTrustlineService,
    { provide: ACCOUNT_FUNDER, useClass: FriendbotFunder },
    AccountProvisioningService,
    BalancesService,
  ],
  // `verifyOtp` is the only consumer, and it is in `IdentityModule`.
  exports: [
    AccountProvisioningService,
    BalancesService,
    /**
     * Step 27 is the first caller outside this module, and it is what moves these three from
     * "private to the wallet" to "part of the wallet's API":
     *
     * - `SeedCustodyService` and `StellarService` are what a submission needs - a signed
     *   transaction requires a key (custody) and a sequence number (the service), and there is no
     *   way to build one from outside without both. Exporting them is the boundary being widened
     *   deliberately rather than worked around: the alternative is a second path to a signature,
     *   which is exactly what the one-door rule in `StellarService` exists to prevent.
     * - `UsdcTrustlineService` is exported for its *asset*, not its trustline: `asset()` is where
     *   "which USDC this deployment is paid in" is answered, and a payment operation that built its
     *   own `Asset` from the config key would be a second answer that could drift from the one the
     *   trustline was created for.
     */
    SeedCustodyService,
    StellarService,
    UsdcTrustlineService,
  ],
})
export class WalletModule {}
