import { Asset, Operation, type xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { SecretEnvelopeError } from '../../wallet/custody/secret-envelope.js';
import { type SeedCustodyService } from '../../wallet/custody/seed-custody.service.js';
import { type UsdcTrustlineService } from '../../wallet/provisioning/usdc-trustline.js';
import { type StellarService } from '../../wallet/stellar/stellar.service.js';
import {
  StellarSubmissionRejectedError,
  StellarSubmissionUnavailableError,
} from '../../wallet/stellar/transaction-submitter.js';
import { PaymentsSubmissionService, compareSequenceNumbers } from './payments-submission.service.js';

/**
 * Step 27's decisions with the database, custody, the sequence lock and Horizon all substituted:
 * *when* each write happens, what each write contains, and which failure becomes which verdict.
 *
 * The claims that need the real world live elsewhere on purpose - `test/submission.e2e-spec.ts`
 * submits to Testnet for real, and the enqueue's bound is asserted there against a Redis that has
 * actually stopped answering. What this file pins is everything that must be visible without a
 * network: the order of the three writes, the fence in both of its halves, and the rule that a
 * failure with no verdict changes nothing.
 *
 * The harness records an ordered trace of what the service did (`calls`), because most of this
 * step's correctness *is* the order: a record written after a submission, or a second build inside
 * one attempt, are bugs that a per-method assertion would miss.
 */

const PAYMENT_ID = '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70';
const SENDER_ID = '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41';
const RECIPIENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SENDER_PUBLIC_KEY = 'GDHU6DLPCPRWP3Z3QXRL6JCMN44X3Q3ZQ3NGCVWXWVJ4GRZ3Z3Z3Z3Z';
const RECIPIENT_PUBLIC_KEY = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** The sequence the row recorded, and - unless a test says otherwise - the one Horizon reports. */
const SEQUENCE = '41';
/** A transaction hash, as the fake transaction and Horizon both spell it: 64 lowercase hex chars. */
const HASH = 'a1'.repeat(32);
/** A hash that is *not* the built transaction's, for the mismatch and restore cases. */
const OTHER_HASH = 'b2'.repeat(32);
/** `maxTime`, as the SDK writes it: unix seconds, as a string. */
const MAX_TIME = '1800000000';
const DEADLINE = new Date(Number(MAX_TIME) * 1000);

/** A `Keypair` stand-in: the only thing this service does with one is hand it to `sign`. */
const FAKE_KEYPAIR = { fake: 'keypair' };

interface RecordedRow {
  readonly hash: string;
  readonly sequence: string;
  readonly deadline: Date;
}

interface HarnessOptions {
  /** The status the row is read with. */
  readonly status?: TransactionStatus;
  /** What the row already records, if anything. */
  readonly recorded?: RecordedRow | null;
  /** The amount in the row, as Prisma spells a `numeric`. */
  readonly amount?: string;
  /** Whether the payment row exists at all. */
  readonly missingRow?: boolean;
  /** Which wallets exist. */
  readonly wallet?: 'both' | 'no-sender' | 'no-recipient';
  /** The sequence number Horizon reports for the sender's account. */
  readonly sequence?: string;
  /** Rows updated by each of the three writes, in order: claim, record, verdict. */
  readonly updated?: readonly (number | undefined)[];
  /** What the submission does: an accepted hash/ledger, or a failure to throw. */
  readonly submit?: { hash?: string; ledger?: number } | Error;
  /** What opening the seed does (a `SecretEnvelopeError`, in the cases that matter). */
  readonly openSeedError?: Error;
}

/**
 * One `submit`, with every collaborator recorded.
 *
 * The three writes are told apart by their `data`, and their counts come from `options.updated` by
 * position - the claim is the first `updateMany`, the record the second, and the verdict (a
 * `FAILED` write or a restore) the third. That is not a shortcut around the service's design; it is
 * what makes the *order* assertable, which is the part of this step that is easiest to get wrong
 * and hardest to see.
 */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const writes: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }> = [];

  const row = {
    id: PAYMENT_ID,
    senderId: SENDER_ID,
    recipientId: RECIPIENT_ID,
    amount: options.amount ?? '10.0000000',
    status: options.status ?? TransactionStatus.PENDING,
    stellarTxHash: options.recorded?.hash ?? null,
    stellarTxSequence: options.recorded?.sequence ?? null,
    submissionDeadline: options.recorded?.deadline ?? null,
  };

  let write = 0;
  const updateMany = vi.fn(
    async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      writes.push(args);
      calls.push(describeWrite(args));

      const count = options.updated?.[write] ?? 1;
      write += 1;

      return { count };
    },
  );

  const prisma = {
    transaction: {
      findUnique: vi.fn(async () => (options.missingRow === true ? null : row)),
      updateMany,
    },
    stellarAccount: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        calls.push(`wallet:${where.userId === SENDER_ID ? 'sender' : 'recipient'}`);

        if (options.wallet === undefined || options.wallet === 'both') {
          return walletRow(where.userId);
        }

        const missing = options.wallet === 'no-sender' ? SENDER_ID : RECIPIENT_ID;

        return where.userId === missing ? null : walletRow(where.userId);
      }),
    },
  };

  const built: Array<{ operations: readonly xdr.Operation[] }> = [];
  const transaction = fakeTransaction();
  const session = {
    sequenceNumber: options.sequence ?? SEQUENCE,
    build: vi.fn((operations: readonly xdr.Operation[]) => {
      calls.push('build');
      built.push({ operations });

      return transaction;
    }),
  };

  const custody = {
    openSeed: vi.fn(async () => {
      calls.push('openSeed');

      if (options.openSeedError !== undefined) {
        throw options.openSeedError;
      }

      return FAKE_KEYPAIR;
    }),
  };

  const stellar = {
    withAccount: vi.fn(
      async (account: string, work: (session: unknown) => Promise<unknown>): Promise<unknown> => {
        calls.push(`lock:${account === SENDER_PUBLIC_KEY ? 'sender' : account}`);

        return work(session);
      },
    ),
    submitTransaction: vi.fn(async () => {
      calls.push('submit');

      if (options.submit instanceof Error) {
        throw options.submit;
      }

      return { hash: options.submit?.hash ?? HASH, ledger: options.submit?.ledger ?? 4_242 };
    }),
  };

  const usdc = { asset: () => new Asset('USDC', ISSUER) };

  return {
    calls,
    writes,
    built,
    transaction,
    updateMany,
    custody,
    stellar,
    session,
    service: new PaymentsSubmissionService(
      prisma as unknown as PrismaService,
      custody as unknown as SeedCustodyService,
      stellar as unknown as StellarService,
      usdc as unknown as UsdcTrustlineService,
    ),
  };
}

/** A wallet row, with the columns custody needs and a distinct public key per user. */
function walletRow(userId: string) {
  return {
    id: `wallet-${userId}`,
    publicKey: userId === SENDER_ID ? SENDER_PUBLIC_KEY : RECIPIENT_PUBLIC_KEY,
    encryptedSecretKey: 'cp-kms-1.test.test.test',
    dataKeyArn: 'arn:aws:kms:eu-west-1:000000000000:key/00000000',
  };
}

/** A built transaction: what `sign`, `hash` and `timeBounds` are asked to do, and nothing else. */
function fakeTransaction() {
  const signed: unknown[] = [];

  return {
    signed,
    sign: (keypair: unknown) => {
      if (keypair !== undefined) {
        signed.push(keypair);
      }
    },
    hash: () => Buffer.from(HASH, 'hex'),
    timeBounds: { minTime: '0', maxTime: MAX_TIME },
  };
}

/** Which of the three writes this is, told apart by the columns it sets. */
function describeWrite(args: { data: Record<string, unknown> }): string {
  const data = args.data;

  if (data['status'] === TransactionStatus.PROCESSING) {
    return 'claim';
  }

  if (data['status'] === TransactionStatus.FAILED) {
    return `failed:${String(data['failureReason'])}`;
  }

  if (typeof data['stellarTxHash'] === 'string') {
    return data['stellarTxHash'] === HASH ? 'record:new' : 'record:previous';
  }

  return 'unrecognised-write';
}

/** The payment operation the attempt built, decoded back to the options it was built from. */
function builtPayment(harnessed: ReturnType<typeof harness>): {
  type: string;
  destination: string;
  asset: Asset;
  amount: string;
} {
  const operation = harnessed.built[0]?.operations[0];

  if (operation === undefined) {
    throw new Error('no operation was built');
  }

  return Operation.fromXDRObject(operation) as unknown as {
    type: string;
    destination: string;
    asset: Asset;
    amount: string;
  };
}

describe('a payment that has never been submitted', () => {
  it('claims it, opens the seed, builds one payment, records it, then submits', async () => {
    const harnessed = harness();

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // The whole order, in one assertion. The two that matter most are `record:new` before
    // `submit` (a transaction Horizon may have accepted is never unrecorded) and `openSeed` before
    // `lock:sender` (a KMS round trip is not held inside the per-account sequence lock).
    expect(harnessed.calls).toEqual([
      'claim',
      'wallet:sender',
      'wallet:recipient',
      'openSeed',
      'lock:sender',
      'build',
      'record:new',
      'submit',
    ]);

    expect(outcome).toEqual({
      status: 'accepted',
      stellarTxHash: HASH,
      ledger: 4_242,
      detail: null,
    });
  });

  it('claims the row with a status-conditioned write, so only one attempt can own it', async () => {
    const harnessed = harness();

    await harnessed.service.submit(PAYMENT_ID);

    // Conditional on `PENDING`: zero rows updated is how a losing attempt finds out, and the
    // condition is what makes that discovery atomic rather than a race between two reads.
    expect(harnessed.writes[0]).toEqual({
      where: { id: PAYMENT_ID, status: TransactionStatus.PENDING },
      data: { status: TransactionStatus.PROCESSING },
    });
  });

  it('records the signed transaction before Horizon is asked, and does not settle it', async () => {
    const harnessed = harness();

    await harnessed.service.submit(PAYMENT_ID);

    // The record: the hash of the *signed* envelope, the sequence it consumed, and the deadline
    // taken from its own time bounds. Written before the submission, conditioned on there being no
    // record yet, and while the payment is still in flight.
    expect(harnessed.writes[1]).toEqual({
      where: { id: PAYMENT_ID, status: TransactionStatus.PROCESSING, stellarTxHash: null },
      data: {
        stellarTxHash: HASH,
        stellarTxSequence: SEQUENCE,
        submissionDeadline: DEADLINE,
      },
    });

    // And nothing else was written: acceptance is not settlement, so the row stays `PROCESSING`
    // until Step 28's poll sees the transaction in a closed ledger. A `SUCCESSFUL` write here would
    // be this step claiming something it did not check.
    expect(harnessed.writes).toHaveLength(2);
    expect(harnessed.writes).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: TransactionStatus.SUCCESSFUL }) }),
    );
  });

  it('builds exactly one payment operation, for the row amount and the configured asset', async () => {
    const harnessed = harness({ amount: '12.3400000' });

    await harnessed.service.submit(PAYMENT_ID);

    const payment = builtPayment(harnessed);

    expect(payment.type).toBe('payment');
    expect(payment.destination).toBe(RECIPIENT_PUBLIC_KEY);
    // The 7-decimal fixed-point string: what `Amount.toStellarAmount()` produces, and the form the
    // ledger uses. A trailing-zero spelling is exactly what the ledger wants here - unlike the
    // column, which gets the canonical `toString()`.
    expect(payment.amount).toBe('12.3400000');
    expect(payment.asset.code).toBe('USDC');
    expect(payment.asset.issuer).toBe(ISSUER);

    // One build, one operation: a payment that carried a second operation (a memo-bearing one, a
    // fee bump) would be a different transaction than the one this step records and reasons about.
    expect(harnessed.session.build).toHaveBeenCalledTimes(1);
    expect(harnessed.built[0]?.operations).toHaveLength(1);
  });

  it('signs with the key custody handed over, and with nothing else', async () => {
    const harnessed = harness();

    await harnessed.service.submit(PAYMENT_ID);

    expect(harnessed.transaction.signed).toEqual([FAKE_KEYPAIR]);
  });

  it('leaves the row alone when another attempt already claimed it', async () => {
    const harnessed = harness({ updated: [0] });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // Zero rows updated by the claim. Nothing else may happen - no seed, no build, not even a
    // wallet read - because this attempt does not own the payment.
    expect(outcome).toEqual({
      status: 'skipped',
      stellarTxHash: null,
      ledger: null,
      detail: 'claimed-elsewhere',
    });
    expect(harnessed.calls).toEqual(['claim']);
  });

  it('fails loudly on a job whose payment does not exist', async () => {
    const harnessed = harness({ missingRow: true });

    // A job with no row is a bug, not a no-op: acknowledging it would report a submission that was
    // never attempted, which is the one failure this step cannot afford to hide.
    await expect(harnessed.service.submit(PAYMENT_ID)).rejects.toThrow(
      `Payment ${PAYMENT_ID} does not exist, so there is nothing to submit - this job has no row`,
    );

    expect(harnessed.calls).toEqual([]);
  });

  it('skips a payment that already has an answer, and touches nothing', async () => {
    for (const status of [TransactionStatus.SUCCESSFUL, TransactionStatus.FAILED]) {
      const harnessed = harness({ status });

      const outcome = await harnessed.service.submit(PAYMENT_ID);

      expect(outcome).toEqual({
        status: 'skipped',
        stellarTxHash: null,
        ledger: null,
        detail: `status:${status}`,
      });
      expect(harnessed.calls).toEqual([]);
    }
  });
});

/** A record whose deadline has passed, and one whose deadline has not: the fence's two sides. */
const EXPIRED: RecordedRow = {
  hash: OTHER_HASH,
  sequence: SEQUENCE,
  deadline: new Date(Date.UTC(2020, 0, 1)),
};
const LIVE: RecordedRow = {
  hash: OTHER_HASH,
  sequence: SEQUENCE,
  deadline: new Date(Date.UTC(2999, 0, 1)),
};

describe('the fence', () => {
  it('defers to a recorded transaction that is still inside its deadline, without opening the seed', async () => {
    const harnessed = harness({ status: TransactionStatus.PROCESSING, recorded: LIVE });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // The transaction already recorded may still land, so this attempt does nothing: no key is
    // fetched, nothing is built, Horizon is not asked, and the row keeps the hash it has. This is
    // what makes a retry after an unanswered submission cheap *and* safe.
    expect(outcome).toEqual({
      status: 'deferred',
      stellarTxHash: OTHER_HASH,
      ledger: null,
      detail: 'recorded-transaction-still-valid',
    });
    expect(harnessed.custody.openSeed).not.toHaveBeenCalled();
    expect(harnessed.stellar.withAccount).not.toHaveBeenCalled();
    expect(harnessed.calls).toEqual(['wallet:sender', 'wallet:recipient']);
  });

  it('rebuilds after the deadline when the sequence was never consumed, over the old record', async () => {
    const harnessed = harness({
      status: TransactionStatus.PROCESSING,
      recorded: EXPIRED,
      sequence: SEQUENCE,
    });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // Both halves of the fence held, so a fresh transaction is legitimate - and the record write
    // compares-and-sets on the *old* hash, which is what stops two rebuilding attempts from both
    // believing they own the row.
    expect(harnessed.writes[0]).toEqual({
      where: { id: PAYMENT_ID, status: TransactionStatus.PROCESSING, stellarTxHash: OTHER_HASH },
      data: {
        stellarTxHash: HASH,
        stellarTxSequence: SEQUENCE,
        submissionDeadline: DEADLINE,
      },
    });
    expect(harnessed.calls).toEqual([
      'wallet:sender',
      'wallet:recipient',
      'openSeed',
      'lock:sender',
      'build',
      'record:new',
      'submit',
    ]);
    expect(outcome.status).toBe('accepted');
  });

  it('stops when the recorded transaction consumed the sequence', async () => {
    // Horizon's sequence has moved past the one the row recorded, which only a landed transaction
    // can do: the recorded transaction is the one to poll, and building a second one would be the
    // double submission this whole design exists to prevent.
    const harnessed = harness({
      status: TransactionStatus.PROCESSING,
      recorded: EXPIRED,
      sequence: String(Number(SEQUENCE) + 1),
    });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    expect(outcome).toEqual({
      status: 'deferred',
      stellarTxHash: OTHER_HASH,
      ledger: null,
      detail: 'recorded-transaction-consumed-the-sequence',
    });
    expect(harnessed.session.build).not.toHaveBeenCalled();
    expect(harnessed.stellar.submitTransaction).not.toHaveBeenCalled();
  });

  it('compares sequences as integers, not as numbers', async () => {
    // 9007199254740992 and 9007199254740993 are the same value to `Number`, and the second is
    // one *past* the first: the fence must see "ahead" here, or it would rebuild a transaction that
    // had already landed.
    const harnessed = harness({
      status: TransactionStatus.PROCESSING,
      recorded: { hash: OTHER_HASH, sequence: '9007199254740992', deadline: EXPIRED.deadline },
      sequence: '9007199254740993',
    });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    expect(outcome.detail).toBe('recorded-transaction-consumed-the-sequence');
    expect(harnessed.session.build).not.toHaveBeenCalled();
  });

  it('retries rather than reasoning about a sequence that went backwards', async () => {
    const harnessed = harness({
      status: TransactionStatus.PROCESSING,
      recorded: EXPIRED,
      sequence: String(Number(SEQUENCE) - 1),
    });

    await expect(harnessed.service.submit(PAYMENT_ID)).rejects.toThrow(
      /behind the 41 this payment recorded/,
    );

    // Nothing was written and nothing was built: an impossible reading from Horizon is a reason to
    // look again, not a state to act on.
    expect(harnessed.writes).toEqual([]);
    expect(harnessed.session.build).not.toHaveBeenCalled();
  });
});

describe('what a failure becomes', () => {
  it('keeps the record and retries when Horizon never answered', async () => {
    const timeout = new StellarSubmissionUnavailableError('Horizon did not answer (ECONNREFUSED)');
    const harnessed = harness({ submit: timeout });

    // The fate of the recorded transaction is unknown - it may have landed - so nothing about the
    // row may change. The error travels out of the handler, which is what makes BullMQ retry.
    await expect(harnessed.service.submit(PAYMENT_ID)).rejects.toBe(timeout);

    expect(harnessed.writes.map((write) => describeWrite(write))).toEqual(['claim', 'record:new']);
  });

  it('fails the payment when the network refuses the operation for good', async () => {
    const refused = new StellarSubmissionRejectedError('tx_failed', ['op_underfunded']);
    const harnessed = harness({ submit: refused });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // A verdict, written where a reader can see it, and *only* while the row is still in flight.
    // The prefix is `landed-unsuccessful:` (Step 28's audit of Step 27's names): the network
    // closed the transaction to answer with `tx_failed`, so the reason describes a ledger entry -
    // the same one the poller would read back for this hash.
    expect(harnessed.writes[2]).toEqual({
      where: { id: PAYMENT_ID, status: TransactionStatus.PROCESSING },
      data: {
        status: TransactionStatus.FAILED,
        failureReason: 'landed-unsuccessful:op_underfunded',
      },
    });
    expect(outcome).toEqual({
      status: 'failed',
      stellarTxHash: null,
      ledger: null,
      detail: 'landed-unsuccessful:op_underfunded',
    });
  });

  it('restores the previous record when a rebuild lost to a settled sequence', async () => {
    // `tx_bad_seq` on a rebuild means the sequence that was still equal when this attempt loaded
    // the account has since been consumed - so the *recorded* transaction landed, and the row goes
    // back to naming it. Step 28's poll then has a hash that can actually appear in a ledger.
    const conflict = new StellarSubmissionRejectedError('tx_bad_seq', []);
    const harnessed = harness({
      status: TransactionStatus.PROCESSING,
      recorded: EXPIRED,
      submit: conflict,
    });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    expect(harnessed.writes[1]).toEqual({
      where: { id: PAYMENT_ID, status: TransactionStatus.PROCESSING, stellarTxHash: HASH },
      data: {
        stellarTxHash: OTHER_HASH,
        stellarTxSequence: EXPIRED.sequence,
        submissionDeadline: EXPIRED.deadline,
      },
    });
    expect(outcome).toEqual({
      status: 'superseded',
      stellarTxHash: OTHER_HASH,
      ledger: null,
      detail: 'tx_bad_seq',
    });
  });

  it('fails a payment whose stored secret cannot be opened, and says which kind of damage it is', async () => {
    const harnessed = harness({
      openSeedError: new SecretEnvelopeError('authentication-failed', 'wallet-id'),
    });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    // Terminal, because nothing has been recorded and no retry can open a blob that cannot be
    // opened. The reason is a short code rather than custody's message, which carries the account
    // id: this text is stored in a column and may be rendered.
    expect(outcome).toEqual({
      status: 'failed',
      stellarTxHash: null,
      ledger: null,
      detail: 'secret-envelope:authentication-failed',
    });
    expect(harnessed.writes[1]?.data).toEqual({
      status: TransactionStatus.FAILED,
      failureReason: 'secret-envelope:authentication-failed',
    });
    expect(harnessed.stellar.withAccount).not.toHaveBeenCalled();
  });

  it('fails a payment whose recipient has no wallet, rather than retrying forever', async () => {
    const harnessed = harness({ wallet: 'no-recipient' });

    const outcome = await harnessed.service.submit(PAYMENT_ID);

    expect(outcome.detail).toBe('wallet-missing:recipient');
    expect(harnessed.custody.openSeed).not.toHaveBeenCalled();
  });

  it('retries a dead transaction instead of failing it, so the fence can decide', async () => {
    // `tx_insufficient_fee` means this transaction can never land - but rebuilding needs a *fresh*
    // sequence load, so the rebuild happens on the next attempt, where the fence decides whether
    // building one is safe. This attempt's job is to not conclude anything.
    const dead = new StellarSubmissionRejectedError('tx_insufficient_fee', []);
    const harnessed = harness({ submit: dead });

    await expect(harnessed.service.submit(PAYMENT_ID)).rejects.toBe(dead);

    expect(harnessed.writes.map((write) => describeWrite(write))).toEqual(['claim', 'record:new']);
  });

  it('retries when Horizon answers about a different envelope than the one recorded', async () => {
    const harnessed = harness({ submit: { hash: OTHER_HASH } });

    await expect(harnessed.service.submit(PAYMENT_ID)).rejects.toThrow(
      /Horizon answered with hash/,
    );
  });
});

describe('compareSequenceNumbers', () => {
  it('answers equal, ahead or behind - as integers', () => {
    expect(compareSequenceNumbers('41', '41')).toBe('equal');
    expect(compareSequenceNumbers('42', '41')).toBe('ahead');
    expect(compareSequenceNumbers('40', '41')).toBe('behind');

    // The reason this is `BigInt` and not `Number`: these two differ by one, and `Number` cannot
    // tell them apart.
    expect(compareSequenceNumbers('9007199254740993', '9007199254740992')).toBe('ahead');
  });

  it('throws on text that is not a sequence number, rather than guessing', () => {
    // Including the empty string: `BigInt('')` is `0n`, so without the digits-only check an empty
    // sequence would silently read as "behind everything" - a state this code would act on.
    expect(() => compareSequenceNumbers('41.5', '41')).toThrow();
    expect(() => compareSequenceNumbers('', '41')).toThrow();
    expect(() => compareSequenceNumbers('41', '4 1')).toThrow();
  });
});
