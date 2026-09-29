import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Operation } from '@stellar/stellar-sdk';
import { SeedCustodyService, type SealedAccountRow } from '../custody/seed-custody.service.js';
import type { StellarBalanceLine } from '../stellar/account-source.js';
import { StellarService } from '../stellar/stellar.service.js';
import type { SubmittedTransaction } from '../stellar/transaction-submitter.js';

/**
 * The asset code a provisioned account trusts.
 *
 * A constant, because an account holding a *different* USD stablecoin is a different
 * product decision rather than a deployment one. The issuer next to it is not: USDC
 * on Testnet is issued by an account that does not exist on mainnet, and each network
 * has exactly one canonical issuer. So the pair is "this code, the issuer this
 * deployment was configured with", and only the second half is config.
 */
export const USDC_ASSET_CODE = 'USDC';

/**
 * An asset's identity: the pair that makes it unique on Stellar.
 *
 * `USDC:GBBD…` and `USDC:GDHU…` are two different assets that happen to share a code, so
 * anything that answers "which USDC" has to carry the issuer too - the same argument
 * `STELLAR_USDC_ISSUER`'s docstring makes for it being configuration.
 */
export interface UsdcAssetIdentity {
  readonly code: string;
  readonly issuer: string;
}

/**
 * The columns `ensureFor` needs - the shape a `StellarAccount` row has.
 *
 * `SealedAccountRow` plus the public key, and nothing else: the row is read once by
 * provisioning and handed straight here, so this is the *whole* of what the trustline
 * step is allowed to know about the account. Extending `SealedAccountRow` rather than
 * restating it keeps `openSeed`'s requirement (id, envelope, ARN) and this service's
 * requirement (a source account) in one place, so a change to custody's inputs cannot
 * silently miss this caller.
 */
export interface TrustlineAccountRow extends SealedAccountRow {
  /**
   * The account that owns the trustline, and so the transaction's source.
   *
   * A trustline is a property *of an account*, so only that account can add it - which
   * is why this step needs the account's own key (via custody) rather than a
   * sponsorship or a platform key. A `G...` public key, never a secret.
   */
  readonly publicKey: string;
}

/**
 * Puts a USDC trustline on a provisioned account (Step 19).
 *
 * Without a trustline an account can hold XLM and nothing else: Stellar requires the
 * recipient of a non-native asset to have opted in, so a USDC payment to an account
 * that has not trusted the issuer is rejected *at the sender*, on the sender's
 * transaction, with an error the sender cannot interpret. That is the failure this
 * class exists to make impossible - and the reason provisioning is not finished until
 * this step has run: "funded" alone leaves a wallet that looks usable and silently
 * refuses money.
 *
 * ## `ensureFor`, not `create`
 *
 * The name says what the caller gets rather than what the call does, because the
 * caller's question is "does this account trust USDC now", and the answer is yes
 * whether this call added the trustline or found one there. See below for why no
 * lookup is needed to answer it.
 *
 * ## The issuer comes from config, and is read once
 *
 * Read in the constructor and never accepted from a caller: the issuer is the
 * deployment's USDC, and a per-call issuer would be a way to make a wallet that trusts
 * an asset nobody will ever pay. `getOrThrow` is what makes a missing issuer a boot
 * failure rather than a wallet that trusts the wrong account - and it cannot be a
 * silently-empty string, because the schema requires the key.
 *
 * ## The SDK is imported here for operations only
 *
 * `StellarService` owns the network, the sequence numbers and the Horizon client; what
 * it deliberately does not own is operation *construction*, because that is where a
 * flow's intent lives - a trustline here, a payment in Step 23. So `Asset` and
 * `Operation` are imported directly and the resulting `xdr.Operation` is handed to the
 * session, which is the same division `stellar.service.ts` describes: no Horizon
 * client is constructed outside it.
 *
 * ## No limit, deliberately
 *
 * `changeTrust` takes an optional limit, and none is set - the SDK then signs the
 * maximum int64, which is what "no limit" means on the wire. A receiving wallet wants
 * the ceiling on an incoming payment to be the *sender's* balance rather than a
 * number this app guessed at registration; and the one limit that is dangerous - a
 * limit of zero - **removes** the trustline, so a mistuned limit would be a way to
 * delete the thing Step 19 exists to create.
 *
 * ## Repeating it is safe, measured rather than assumed
 *
 * Asked for a trustline an account already has, Testnet accepts the transaction
 * (`tx_success`, a new hash, no `op_` code) - `changeTrust` is not a
 * create-if-absent, it is a set-the-limit operation, and setting the same limit twice
 * is a no-op at the ledger level. That is what makes provisioning retryable: an
 * account that got as far as being funded but not trusted can be re-provisioned
 * without a "does it already have one?" check first.
 *
 * This class still submits without asking - the ledger accepts the repeat either way, so
 * the check is not required *here*. A caller that has a reason to ask anyway can:
 * `isUsdcLine` answers "is this line already my trustline" from the same
 * `StellarService.loadBalances` port Step 20 built, and `AccountProvisioningService` uses
 * it to decide whether a half-provisioned account still needs this transaction at all
 * rather than buying a submission the ledger will ignore.
 *
 * ## Signing happens inside the account's lock
 *
 * The build, the signature and the submission are all inside one `withAccount`
 * section, so the sequence number this transaction consumes is the one Horizon
 * reported for it and no second transaction can be built from the same snapshot while
 * this one is in flight. Signing is the *last* thing that happens to a transaction
 * (any later change to its contents invalidates the signature), which is why the
 * callback shape - not a pre-built transaction - is what this method asks
 * `StellarService` for.
 *
 * ## Failures propagate
 *
 * Nothing is caught here. A submission failure is already classified by
 * `StellarTransactionSubmitter` into "rejected" (the trustline is not there, and
 * something has to change) and "unavailable" (unknown - it may have landed); both
 * become an outcome and a log line in `AccountProvisioningService`, the layer that
 * knows whether this registration still has a chance of succeeding.
 */
@Injectable()
export class UsdcTrustlineService {
  private readonly issuer: string;

  constructor(
    /**
     * The only way to reach the network: this class never builds a client, never
     * holds a sequence number of its own, and never submits outside `StellarService`,
     * so this transaction is serialised against every other transaction for the
     * account by construction.
     */
    private readonly stellar: StellarService,
    /**
     * Opens the account's seed for the one purpose it is needed - the signature. No
     * reference to the keypair is kept: it is a local of `ensureFor`, and a field
     * holding one would be the single most valuable thing in this process.
     */
    private readonly custody: SeedCustodyService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<string>('stellar.usdcIssuer');
  }

  /**
   * The asset a provisioned account trusts: `USDC` from this network's issuer.
   *
   * Exposed because "what is a payment to this user denominated in" is a question
   * Step 20 and Step 23 have to answer identically, and they should answer it by
   * asking this service rather than by re-reading the config key and hoping the code
   * half still says `USDC`.
   */
  asset(): Asset {
    return new Asset(USDC_ASSET_CODE, this.issuer);
  }

  /**
   * The same asset, as the two strings a response body can carry.
   *
   * `asset()` is what a transaction needs and this is what a body needs. The SDK types
   * `Asset.getIssuer()` as `string | undefined` - it also models the *native* asset, which
   * has no issuer - and an `undefined` must not reach a JSON response as a missing field,
   * so the pair is built here from the same two values the `Asset` is built from, in one
   * place, instead of a caller handling a case that cannot happen in this deployment.
   */
  assetIdentity(): UsdcAssetIdentity {
    return { code: USDC_ASSET_CODE, issuer: this.issuer };
  }

  /**
   * Whether one of Horizon's balance lines *is* the USDC trustline this app establishes.
   *
   * The comparison is the asset identity - code *and* issuer - never the code alone:
   * `USDC:GBBD…` and `USDC:GDHU…` are two different assets that happen to share a code
   * (the reason `UsdcAssetIdentity` exists), so a line matched on the code would read as
   * "this account can receive USDC" when it in fact trusts somebody else's. Answering
   * from `assetIdentity()` rather than restating `USDC` here is also what keeps this
   * answer identical to `BalancesService`'s, which builds its USDC line from the same
   * method (Step 20's spec pins that it is not a literal there).
   *
   * Takes a line rather than an account because the caller already has the lines: they
   * arrive with the account load, so this is a comparison with no round trip of its own to
   * hide - and no way to report a trustline from a response that was never fetched.
   */
  isUsdcLine(line: StellarBalanceLine): boolean {
    const { code, issuer } = this.assetIdentity();

    return line.asset_code === code && line.asset_issuer === issuer;
  }

  /**
   * Gives `account` a USDC trustline, and reports the transaction that did it.
   *
   * Assumes the account is *funded*: an unfunded Stellar account cannot be loaded
   * (there is nothing to load), so `withAccount` would fail with Horizon's 404 and the
   * error would read "not found" rather than "not funded yet". That ordering is
   * enforced one layer up, where the funder runs first.
   */
  async ensureFor(account: TrustlineAccountRow): Promise<SubmittedTransaction> {
    /**
     * Before the lock, on purpose: unwrapping the seed is a KMS round trip, and
     * holding a per-account queue across a call to a different service would serialise
     * every transaction for that account behind a key fetch. Nothing in between can
     * use the keypair - it signs, and the transaction does not exist until the lock is
     * held.
     */
    const keypair = await this.custody.openSeed(account);

    return this.stellar.withAccount(account.publicKey, async (session) => {
      const transaction = session.build([Operation.changeTrust({ asset: this.asset() })]);

      transaction.sign(keypair);

      return this.stellar.submitTransaction(transaction);
    });
  }
}
