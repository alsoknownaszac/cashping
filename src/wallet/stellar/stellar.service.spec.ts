import type { ConfigService } from '@nestjs/config';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  type Transaction,
  type TransactionSource,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { StellarNetwork } from '../../config/validation.schema.js';
import type { StellarAccountSource } from './account-source.js';
import { StellarAccountSession } from './stellar-account-session.js';
import { StellarService } from './stellar.service.js';

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
  /** The highest number of loads that were ever in flight at once. */
  maxConcurrentLoads = 0;
  /** When set, loading fails with this instead of answering. */
  failWith: Error | undefined;
  private inFlight = 0;

  async loadAccount(accountId: string): Promise<TransactionSource> {
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
      // a submission can really advance the account.
      return new Account(accountId, snapshot);
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

function createService(horizon: StellarAccountSource, network = 'TESTNET'): StellarService {
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

  return new StellarService(config, horizon);
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
});
