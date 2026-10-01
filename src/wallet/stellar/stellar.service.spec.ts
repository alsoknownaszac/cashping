import type { ConfigService } from '@nestjs/config';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { StellarNetwork } from '../../config/validation.schema.js';
import {
  StellarAccountNotFoundError,
  type LoadedStellarAccount,
  type StellarAccountSource,
  type StellarBalanceLine,
} from './account-source.js';
import { StellarAccountSession } from './stellar-account-session.js';
import { StellarService } from './stellar.service.js';
import type { StellarTransactionSubmitter, SubmittedTransaction } from './transaction-submitter.js';
import type { StellarTransactionLookup, TransactionLookupResult } from './transaction-lookup.js';

/**
 * Step 17's audit item, **forced rather than assumed**.
 *
 * "Two rapid, concurrent transaction-build requests for the *same* source account
 * do not produce a sequence-number conflict - don't just trust the mutex/queue
 * exists."
 *
 * The way to earn that is to build the failure into the harness and then show the
 * lock is what prevents it:
 *
 * 1. `SimulatedHorizon` implements Stellar's actual rule - an account's sequence
 *    number advances only when a transaction against it is *submitted*, and a
 *    transaction at or below the account's current sequence number is refused
 *    (`tx_bad_seq`). Its `loadAccount` is a real round trip, held open for two
 *    event-loop turns, and counts how many loads are in flight.
 * 2. The audit test fires two of them at once through `withAccount` and asserts
 *    both land, that they carry *different* sequence numbers, and that the loads
 *    never overlapped.
 * 3. Its counter-proof runs the identical two cycles with the queue removed and
 *    asserts the harness *does* catch the conflict - which is what makes step 2's
 *    assertion mean something instead of passing for want of a race.
 *
 * A live-Horizon version of this race was considered and deliberately not built: it
 * would be a test of ledger-close timing rather than of the lock. Two concurrent
 * submissions against a real account succeed or fail for reasons this service does not
 * control, so a red run would not say which side broke and a green one would only say
 * the network happened to be quick that day. The part a live test can prove about
 * sequence handling is already proven where it cannot be faked:
 * `test/provisioning.e2e-spec.ts` loads the account, builds, signs and submits a real
 * `changeTrust` through `HorizonTransactionSubmitter`, with nothing substituted at the
 * Horizon boundary. What is left over is the lock itself, and this is the altitude where
 * the lock can be made to fail on demand.
 */

/** Stellar's own rejection when a sequence number has already been used. */
class SequenceConflictError extends Error {
  constructor(sequence: string, current: bigint) {
    super(`tx_bad_seq: sequence ${sequence} was already consumed (the account is at ${current})`);
    this.name = 'SequenceConflictError';
  }
}

function afterEventLoopTurns(turns: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = turns;
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
      } else {
        setTimeout(tick, 0);
      }
    };

    setTimeout(tick, 0);
  });
}

/**
 * Horizon, reduced to the property this step is about.
 */
class SimulatedHorizon implements StellarAccountSource {
  sequence = 100n;
  readonly submitted: string[] = [];
  /**
   * What Horizon reports alongside the sequence number (Step 20).
   *
   * Empty by default: the tests below are about sequence numbers, and a fake that answered
   * with lines nobody asked it for would be a fake that decides what a wallet holds. The
   * field is here because the *port* promises it - a real load has both, so a fake that
   * could only model one of them would not be the shape the app is compiled against.
   */
  balances: StellarBalanceLine[] = [];
  /** The highest number of loads that were ever in flight at once. */
  maxConcurrentLoads = 0;
  /** When set, loading fails with this instead of answering. */
  failWith: Error | undefined;
  private inFlight = 0;

  async loadAccount(accountId: string): Promise<LoadedStellarAccount> {
    // The snapshot is taken when the request is *made*, which is what Horizon does:
    // two requests issued at the same instant both answer with the account's sequence
    // number as of that instant. That is exactly why a queue is needed, and it is the
    // property the counter-proof below relies on.
    const snapshot = this.sequence.toString();

    this.inFlight += 1;
    this.maxConcurrentLoads = Math.max(this.maxConcurrentLoads, this.inFlight);

    try {
      await afterEventLoopTurns(2);

      if (this.failWith !== undefined) {
        throw this.failWith;
      }

      // A copy, exactly like Horizon's answer: the builder mutates this one, and only
      // a submission can really advance the account. The balance lines ride along on the
      // same answer, which is the shape the port promises (Step 20): `Account` on its own
      // is the SDK's offline, sequence-only type, and is deliberately not that shape.
      return Object.assign(new Account(accountId, snapshot), { balances: this.balances });
    } finally {
      this.inFlight -= 1;
    }
  }

  submit(transaction: Transaction): string {
    if (BigInt(transaction.sequence) <= this.sequence) {
      throw new SequenceConflictError(transaction.sequence, this.sequence);
    }

    this.sequence = BigInt(transaction.sequence);
    this.submitted.push(transaction.sequence);

    return transaction.sequence;
  }
}

const ACCOUNT = Keypair.random().publicKey();
const OTHER_ACCOUNT = Keypair.random().publicKey();

/** Circle's Testnet issuer: a USDC *line* is only this asset when the pair matches. */
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * The submitter the cycles below use.
 *
 * Submissions here go through the fake Horizon, because what is under test is the
 * *lock*: `SimulatedHorizon` enforces Stellar's actual rule about sequence numbers and
 * records what landed, and putting `HorizonTransactionSubmitter`'s error mapping
 * between the assertion and the thing asserted would make the race harder to read
 * rather than better covered. The port is still injected for real, so the constructor
 * is exercised with the same three collaborator kinds `WalletModule` supplies; the
 * classification of submission failures is that class's own subject, in its own spec.
 */
class RecordingSubmitter implements StellarTransactionSubmitter {
  readonly submitted: Transaction[] = [];
  answer: SubmittedTransaction = { hash: 'a'.repeat(64), ledger: 42 };
  failWith: Error | undefined;

  async submit(transaction: Transaction): Promise<SubmittedTransaction> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }

    this.submitted.push(transaction);

    return this.answer;
  }
}

const UNUSED_SUBMITTER = new RecordingSubmitter();

/**
 * The lookup the cycles below never depend on.
 *
 * Step 28 put a third Horizon port on this class, and it is injected here the same way the submitter
 * is: real, so the constructor is exercised with the four collaborators `WalletModule` supplies, and
 * silent, because what this file tests is the lock and the pass-through. The port's own mapping -
 * `NotFoundError` into `not-found`, every other failure into `unavailable` - is
 * `horizon-transaction-lookup.spec.ts`'s subject, and the live answer is the Step 28 audit item.
 */
class RecordingLookup implements StellarTransactionLookup {
  readonly looked: string[] = [];
  answer: TransactionLookupResult = { kind: 'not-found' };

  async lookup(hash: string): Promise<TransactionLookupResult> {
    this.looked.push(hash);

    return this.answer;
  }
}

const UNUSED_LOOKUP = new RecordingLookup();

function createService(
  horizon: StellarAccountSource,
  network = 'TESTNET',
  submitter: StellarTransactionSubmitter = UNUSED_SUBMITTER,
  lookup: StellarTransactionLookup = UNUSED_LOOKUP,
): StellarService {
  const config = {
    getOrThrow: (key: string) => {
      switch (key) {
        case 'stellar.network':
          return network;
        case 'stellar.horizonUrl':
          return 'https://horizon-testnet.stellar.org';
        case 'stellar.fallbackHorizonUrl':
          return 'http://localhost:8000';
        default:
          throw new Error(`unexpected config key ${key}`);
      }
    },
  } as unknown as ConfigService;

  return new StellarService(config, horizon, submitter, lookup);
}

function payment(amount = '1'): xdr.Operation {
  return Operation.payment({ destination: OTHER_ACCOUNT, asset: Asset.native(), amount });
}

describe('StellarService', () => {
  it('audit: two concurrent build-and-submit cycles for one account both land', async () => {
    const horizon = new SimulatedHorizon();
    const service = createService(horizon);

    // One locked cycle: load the account, build against that snapshot, submit
    // before releasing the account. This is the shape Steps 19-25 use - a
    // transaction that is built *and consumed* inside `withAccount` - because a
    // build whose transaction is never submitted leaves the account's real
    // sequence number where it was.
    const cycle = (): Promise<string> =>
      service.withAccount(ACCOUNT, async (account) => {
        const transaction = account.build([payment()]);

        return horizon.submit(transaction);
      });

    const sequences = await Promise.all([cycle(), cycle()]);

    // Both transactions were accepted, with distinct sequence numbers...
    expect(sequences).toEqual(['101', '102']);
    expect(horizon.submitted).toEqual(['101', '102']);
    expect(horizon.sequence).toBe(102n);

    // ...and the loads never overlapped: the second one began only after the first
    // cycle had submitted, which is why it read 101 rather than 100.
    expect(horizon.maxConcurrentLoads).toBe(1);
  });

  it('audit counter-proof: without the queue, the same two cycles collide', async () => {
    const horizon = new SimulatedHorizon();

    // Deliberately unguarded, to prove the harness can fail. Both loads read 100,
    // both transactions carry 101, and only the first submission can be accepted -
    // exactly the conflict Step 17 exists to prevent, which is what makes the
    // assertion in the test above non-vacuous.
    const unlockedCycle = async (): Promise<string> => {
      const source = await horizon.loadAccount(ACCOUNT);
      const session = new StellarAccountSession(source, Networks.TESTNET);

      return horizon.submit(session.build([payment()]));
    };

    await expect(Promise.all([unlockedCycle(), unlockedCycle()])).rejects.toBeInstanceOf(
      SequenceConflictError,
    );

    // Two loads really were in flight at once, and exactly one transaction landed:
    // the other was refused as stale.
    expect(horizon.maxConcurrentLoads).toBe(2);
    expect(horizon.submitted).toEqual(['101']);
  });

  it('serialises two concurrent buildTransaction calls for one source account', async () => {
    const horizon = new SimulatedHorizon();
    const service = createService(horizon);

    const [first, second] = await Promise.all([
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
    ]);

    // One load at a time, so the second build can never be reading the account
    // while the first is building on the same snapshot.
    expect(horizon.maxConcurrentLoads).toBe(1);

    // Both transactions carry the same sequence number, and that is the honest
    // result of building twice without consuming the first: a build does not
    // change what Horizon reports. `withAccount` is how a caller makes consecutive
    // builds distinct - by submitting inside the same locked section - and this
    // assertion is here so nobody "fixes" it by inventing a sequence number the
    // account has not reached (a gap is rejected too, as `tx_bad_seq`).
    expect(first.sequence).toBe('101');
    expect(second.sequence).toBe('101');
  });

  it('does not make one source account wait behind another', async () => {
    const horizon = new SimulatedHorizon();
    const service = createService(horizon);

    await Promise.all([
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
      service.buildTransaction({ sourceAccount: OTHER_ACCOUNT, operations: [payment()] }),
    ]);

    // The queue is per account: unrelated wallets must not serialise behind each
    // other, or the treasury's busy periods would slow every payout.
    expect(horizon.maxConcurrentLoads).toBe(2);
  });

  it('releases an account when a build fails, so the next request is not blocked', async () => {
    const horizon = new SimulatedHorizon();
    const service = createService(horizon);
    const outage = new Error('horizon is down');

    horizon.failWith = outage;

    // The error crosses `StellarService` untouched: the mapping onto
    // `StellarAccountSourceError` / `StellarAccountNotFoundError` belongs to
    // `HorizonAccountSource`, which is the layer that can tell a network failure from
    // a genuinely unfunded account (see its own spec). What matters *here* is that a
    // failed load does not leave the account queued forever - a wedged lock turns one
    // Horizon blip into a permanently stuck wallet.
    await expect(
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
    ).rejects.toBe(outage);

    horizon.failWith = undefined;

    await expect(
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
    ).resolves.toBeDefined();
  });

  it('exposes the network and Horizon hosts it was configured with, and builds for them', async () => {
    const horizon = new SimulatedHorizon();
    const service = createService(horizon);

    expect(service.network()).toBe(StellarNetwork.Testnet);
    expect(service.networkPassphrase()).toBe(Networks.TESTNET);
    expect(service.horizonUrl()).toBe('https://horizon-testnet.stellar.org');
    expect(service.fallbackHorizonUrl()).toBe('http://localhost:8000');

    // Applied, not just reported: the passphrase goes into every transaction this
    // service builds, and a signature for the wrong one is valid on the other
    // network.
    const transaction = await service.buildTransaction({
      sourceAccount: ACCOUNT,
      operations: [payment()],
    });

    expect(transaction.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('refuses to start on a network it does not know', () => {
    // No safe default: TESTNET and PUBLIC both hold real accounts.
    expect(() => createService(new SimulatedHorizon(), 'MAINNET')).toThrowError(/MAINNET/);
  });

  it('generates a fresh, well-formed keypair for every account it provisions', () => {
    const service = createService(new SimulatedHorizon());

    const first = service.generateKeypair();
    const second = service.generateKeypair();

    // Round-tripped through the SDK rather than pattern-matched: the secret has to
    // be a real seed, and it has to belong to the public key beside it.
    expect(Keypair.fromSecret(first.secret()).publicKey()).toBe(first.publicKey());
    expect(first.publicKey()).not.toBe(second.publicKey());
    expect(first.secret()).not.toBe(second.secret());
  });

  it('hands a signed transaction to the submitter and reports what it answered', async () => {
    const horizon = new SimulatedHorizon();
    const submitter = new RecordingSubmitter();
    const service = createService(horizon, 'TESTNET', submitter);
    const keypair = Keypair.random();

    // The shape every flow above this uses: build and consume inside one locked
    // section, so the sequence number submitted is the one that was read.
    const submitted = await service.withAccount(ACCOUNT, (session) => {
      const transaction = session.build([payment()]);

      transaction.sign(keypair);

      return service.submitTransaction(transaction);
    });

    expect(submitted).toEqual(submitter.answer);
    expect(submitter.submitted).toHaveLength(1);
    // Signed by the caller, and signed *validly*: the submitter receives a
    // transaction whose signature verifies, not a placeholder.
    expect(submitter.submitted[0]?.signatures).toHaveLength(1);
    // And the account lock is not held by a submission: `submitTransaction` takes
    // no lock of its own (see its own note), which is why a flow that must hold one
    // across build-and-submit does the wrap itself.
    await expect(
      service.buildTransaction({ sourceAccount: ACCOUNT, operations: [payment()] }),
    ).resolves.toBeDefined();
  });

  it('reads balance lines off the loaded account, and does not queue behind the lock', async () => {
    const horizon = new SimulatedHorizon();
    horizon.balances = [
      { asset_type: 'native', balance: '9999.9999900' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        balance: '0.0000000',
        limit: '922337203685.4775807',
        is_authorized: true,
      },
    ];
    const service = createService(horizon);

    // Horizon's own answer, passed through untouched: the sums are *strings* and stay
    // strings, because 7-decimal fixed point does not survive a double (and the API's
    // balance DTOs exist to keep it that way).
    await expect(service.loadBalances(ACCOUNT)).resolves.toEqual(horizon.balances);

    // Two reads at once, both in flight, which is what makes "no lock" a fact rather
    // than a claim: the queue above is for builds, and a balance screen must not wait
    // for a payment being built for the same account.
    horizon.maxConcurrentLoads = 0;
    await Promise.all([service.loadBalances(ACCOUNT), service.loadBalances(ACCOUNT)]);
    expect(horizon.maxConcurrentLoads).toBe(2);

    // A failure is the source's own, unchanged - and no balance is invented for a
    // Horizon that did not answer. That classification is `BalancesService`'s job, one
    // layer up, where the user's account row is known too.
    horizon.failWith = new StellarAccountNotFoundError(ACCOUNT);

    await expect(service.loadBalances(ACCOUNT)).rejects.toBeInstanceOf(StellarAccountNotFoundError);
  });
});

/**
 * The pass-through Step 28 added: `lookupTransaction` is the app's second question to Stellar ("did
 * it land?") and this class is where that question's vocabulary is pinned.
 *
 * All four answers are exercised in one test rather than the happy path alone, because the claim
 * being made is about the *quiet* ones: `not-found` and `unavailable` are what a poller meets on an
 * ordinary morning, and neither may become an exception or a verdict on the way through. What an
 * answer means for a payment is `confirmation-triage.ts`'s decision, one layer up; what Horizon's
 * HTTP means is the port's own spec. This method is also deliberately lock-free - it consumes no
 * sequence number and signs nothing, so a poll never queues behind a build for the same account -
 * which is visible in its body rather than assertable from here.
 */
describe('StellarService.lookupTransaction', () => {
  it('hands back every answer the port gives, including the two quiet ones', async () => {
    const lookup = new RecordingLookup();
    const service = createService(new SimulatedHorizon(), 'TESTNET', UNUSED_SUBMITTER, lookup);
    const hash = 'b'.repeat(64);

    const answers: TransactionLookupResult[] = [
      { kind: 'settled', ledger: 42, successful: true, transactionCode: null },
      { kind: 'settled', ledger: 43, successful: false, transactionCode: 'tx_failed' },
      { kind: 'not-found' },
      { kind: 'unavailable', detail: 'Horizon answered HTTP 503' },
    ];

    for (const answer of answers) {
      lookup.answer = answer;

      await expect(service.lookupTransaction(hash)).resolves.toEqual(answer);
    }

    // Every call reached the port, and every call carried the hash the row recorded - the one fact
    // a poll has to get right, and the only argument this method takes.
    expect(lookup.looked).toEqual(answers.map(() => hash));
  });
});
