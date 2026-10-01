import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { StellarNetwork } from '../../config/validation.schema.js';
import { AccountLock } from './account-lock.js';
import {
  STELLAR_ACCOUNT_SOURCE,
  type StellarAccountSource,
  type StellarBalanceLine,
} from './account-source.js';
import { StellarAccountSession, type TransactionOptions } from './stellar-account-session.js';
import { networkPassphraseFor, parseStellarNetwork } from './stellar-network.js';
import {
  STELLAR_TRANSACTION_SUBMITTER,
  type StellarTransactionSubmitter,
  type SubmittedTransaction,
} from './transaction-submitter.js';
import {
  STELLAR_TRANSACTION_LOOKUP,
  type StellarTransactionLookup,
  type TransactionLookupResult,
} from './transaction-lookup.js';

/** A transaction request: which account pays, and what it should do. */
export interface BuildTransactionRequest extends TransactionOptions {
  /** Source account, in `G...` form. */
  sourceAccount: string;
  /** The operations to carry. At least one: Stellar has no empty transactions. */
  operations: readonly xdr.Operation[];
}

/**
 * The app's single door to Stellar (Step 17).
 *
 * Everything else in the codebase - provisioning in Step 19, balances in Step 20,
 * payments in Step 23 - goes through this class rather than importing the SDK, so
 * that three things are decided once:
 *
 * 1. **Which network.** The passphrase is read at construction and never accepted
 *    from a caller, so no flow can build a testnet transaction by passing the
 *    wrong string, and a misconfigured `STELLAR_NETWORK` fails at boot rather than
 *    at the first signature.
 * 2. **Sequence numbers are serialised per source account.** Two transactions
 *    carrying the same sequence number cannot both be accepted; see `AccountLock`
 *    and `StellarAccountSession` for why that is a queue and not just a type.
 * 3. **Nothing here holds a secret.** `generateKeypair` returns a keypair to its
 *    caller and keeps no reference to it; custody (KMS-encrypted seeds) is Step
 *    18's problem, and no key material reaches this class's fields or any log.
 * 4. **There is one way to reach Horizon.** Loading a sequence number, submitting a
 *    signed transaction and looking up what became of one are all ports this class
 *    owns, so no other file imports a Horizon client, and a submission failure is
 *    classified the same way wherever it happens. (Step 28 added the third port: the
 *    confirmation poll asks "did it settle" in this class's vocabulary too.)
 *
 * ## The two ways in, and why both exist
 *
 * `buildTransaction` is the convenience form: take the lock, load the account,
 * build, release. Two *concurrent* build requests for one source account are
 * therefore serialised - neither can be reading the sequence number while the
 * other is already building on the same snapshot, which is the interleaving that
 * makes concurrent build requests collide.
 *
 * `withAccount` is what callers should reach for whenever the transaction is not
 * the end of the story - which, for anything that moves money, it never is. It
 * holds the lock across the whole callback, so load -> build -> sign -> submit is
 * one indivisible step and the *next* build's load observes the sequence number
 * this one consumed. Building without consuming is what leaves two valid-looking
 * transactions carrying the same sequence number, so `buildTransaction` is
 * exposed as "build one transaction, serialised against every other build for
 * this account", not as "your sequence number is safe from here on".
 */
@Injectable()
export class StellarService {
  /**
   * Per source account, for the life of the process. Deliberately an instance
   * field rather than a module-level singleton: the lock only means anything if
   * every caller of this service shares it, and Nest's default provider scope
   * (one instance per module) is what makes that true.
   */
  private readonly lock = new AccountLock();
  private readonly selectedNetwork: StellarNetwork;
  private readonly passphrase: string;
  private readonly primaryHorizonUrl: string;
  private readonly fallbackUrl: string;

  constructor(
    config: ConfigService,
    @Inject(STELLAR_ACCOUNT_SOURCE) private readonly accounts: StellarAccountSource,
    @Inject(STELLAR_TRANSACTION_SUBMITTER)
    private readonly submitter: StellarTransactionSubmitter,
    @Inject(STELLAR_TRANSACTION_LOOKUP)
    private readonly transactions: StellarTransactionLookup,
  ) {
    // Read and validated once, at construction: boot fails on a bad
    // `STELLAR_NETWORK`, not the first payment of the day.
    this.selectedNetwork = parseStellarNetwork(config.getOrThrow<string>('stellar.network'));
    this.passphrase = networkPassphraseFor(this.selectedNetwork);
    this.primaryHorizonUrl = config.getOrThrow<string>('stellar.horizonUrl');
    this.fallbackUrl = config.getOrThrow<string>('stellar.fallbackHorizonUrl');
  }

  /** The network this process builds for. */
  network(): StellarNetwork {
    return this.selectedNetwork;
  }

  /** The passphrase this process signs for. */
  networkPassphrase(): string {
    return this.passphrase;
  }

  /** The Horizon host accounts are loaded from. */
  horizonUrl(): string {
    return this.primaryHorizonUrl;
  }

  /**
   * The second Horizon host, for the same network.
   *
   * Nothing consults it yet: it is a slot, kept in config so that pointing the
   * failover at a real host is a deployment decision rather than a code change. A
   * fallback used today would be worse than none - a Horizon that is merely slow
   * would be raced by a second one, and answers from the two would interleave.
   */
  fallbackHorizonUrl(): string {
    return this.fallbackUrl;
  }

  /**
   * A brand-new keypair for an account that does not exist yet.
   *
   * The caller owns the result: it is never stored here, never logged, and never
   * used for anything until Step 18 puts the secret behind KMS.
   */
  generateKeypair(): Keypair {
    return Keypair.random();
  }

  /**
   * Loads `sourceAccount` and hands it to `work` as a sequence-number-bound
   * session, with nothing else allowed to touch that account until `work` has
   * finished.
   */
  withAccount<T>(
    sourceAccount: string,
    work: (account: StellarAccountSession) => Promise<T> | T,
  ): Promise<T> {
    return this.lock.run(sourceAccount, async () => {
      const source = await this.accounts.loadAccount(sourceAccount);

      return work(new StellarAccountSession(source, this.passphrase));
    });
  }

  /**
   * Builds one transaction for `request.sourceAccount`, serialised against every
   * other build for that account.
   */
  buildTransaction(request: BuildTransactionRequest): Promise<Transaction> {
    return this.withAccount(request.sourceAccount, (account) =>
      account.build(request.operations, request),
    );
  }

  /**
   * The account's balance lines, exactly as Horizon reported them (Step 20).
   *
   * **No lock, deliberately.** The per-account queue exists because a *build* consumes a
   * sequence number and two builds made from one snapshot collide; a balance read consumes
   * nothing. Putting it behind the queue would make a balance screen wait for whatever
   * payment is in flight for the same account, and would say the queue protects something
   * it does not.
   *
   * The array is Horizon's own, passed through untouched: this method adds no default, no
   * rounding and no filtering - so a caller cannot receive a `0` that Horizon did not
   * report. What an unfunded account, a missing trustline or an unreachable Horizon should
   * look like is decided one layer up, in `BalancesService`, where the signed-in user's
   * account row is also known.
   */
  async loadBalances(accountId: string): Promise<readonly StellarBalanceLine[]> {
    const account = await this.accounts.loadAccount(accountId);

    return account.balances;
  }

  /**
   * Sends an already-signed transaction to the network, and resolves with what
   * Horizon said about it.
   *
   * The caller signs, not this class: signing needs the account's keypair, which
   * lives behind custody (Step 18) and is opened by the flow that knows what it is
   * spending - not held here, where it could outlive the call. What this method adds
   * is the *single exit*: every submission in the app goes through one port, so a
   * classification of "rejected" versus "no verdict" is never re-derived locally.
   *
   * It deliberately does not take the account lock. Submitting is the *end* of a
   * locked section, not a step inside one that a second caller can interleave with -
   * the flows that must hold a lock across build-and-submit do so by calling this
   * from inside their `withAccount` callback (see `withAccount` above).
   */
  submitTransaction(transaction: Transaction): Promise<SubmittedTransaction> {
    return this.submitter.submit(transaction);
  }

  /**
   * What the network has to say about a transaction hash (Step 28): in a ledger or not, and if
   * it landed, whether the ledger accepted it.
   *
   * The read half of `submitTransaction`, and here rather than in the caller for the same reason:
   * this class owns the only Horizon clients in the app, and "did it settle" is a question about
   * Stellar that every caller should have to ask in the same vocabulary. It takes no lock and no
   * passphrase - looking a transaction up consumes no sequence number and signs nothing - so it
   * is safe to call while another build is in flight for the same account.
   *
   * Resolves for all three answers (see `TransactionLookupResult`), and never throws for a
   * Horizon that did not answer: a poller reads this repeatedly, and "Horizon is down" must be a
   * value it can count rather than an exception it has to catch.
   */
  lookupTransaction(hash: string): Promise<TransactionLookupResult> {
    return this.transactions.lookup(hash);
  }
}
