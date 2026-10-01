import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type BalanceResponseDto } from '../../wallet/dto/balance-response.dto.js';
import { type BalancesService } from '../../wallet/balances/balances.service.js';
import { type PaymentsQueueService } from '../jobs/payments-queue.service.js';
import { type RecipientsService } from './recipients.service.js';
import { PaymentsService } from './payments.service.js';

/**
 * Step 25's decisions, with the database, the wallet read and the recipient check all
 * substituted: *when* each check runs, what each answer becomes, and what the row gets written
 * with.
 *
 * The two claims this step is graded on live elsewhere, because they are about the real thing:
 * `test/payments.e2e-spec.ts` (one row per key; no overdraft under a forced race, against real
 * Postgres). What this file pins is the part no e2e should be the only witness for - the *order*
 * of the checks (a payment to nobody payable must not take a lock, and the balance is read
 * before the transaction opens rather than inside it), the mapping from each failure to its
 * status, and the exact string that reaches the `numeric(20, 7)` column.
 */

const SENDER: SessionUser = {
  id: '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41',
  phoneNumber: '+233241234567',
  status: 'ACTIVE',
  handle: 'ama',
};

const RECIPIENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = 'b2d3f4a5-6c7d-4e8f-9a0b-1c2d3e4f5a6b';
const CREATED_AT = new Date('2026-09-29T16:53:53.412Z');

/** What Horizon reports for a healthy wallet holding `balance`. */
function walletWith(balance: string | null): BalanceResponseDto {
  return {
    asset: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    balance,
    trustline: balance === null ? 'missing' : 'active',
    funded: balance !== null,
  };
}

interface HarnessOptions {
  /** The wallet read: an amount string, a `BalanceResponseDto`, `null` for no line, or an error. */
  wallet?: string | BalanceResponseDto | Error | null;
  /** What the in-flight `SUM` answers, as Prisma would spell it. */
  inFlight?: string | null;
  /** The recipient check: a row, or the 404 `RecipientsService` throws. */
  recipient?: { id: string } | Error;
  /** What the insert raises, if anything. */
  insertError?: unknown;
  /** What the enqueue raises, if anything. */
  enqueueError?: unknown;
  /** The amount the *row* holds, when the response should be read from it. */
  storedAmount?: string;
}

/**
 * One `create`, with every collaborator recorded: `calls` is the order the steps happened in,
 * which is the only way "the lock is taken after the balance read" or "nobody is looked up for a
 * self-payment" can be asserted rather than asserted-about.
 */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];

  const row = {
    id: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
    status: TransactionStatus.PENDING,
    amount: options.storedAmount ?? '10',
    createdAt: CREATED_AT,
  };

  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');

      return [{ id: 'wallet-row' }];
    }),
    transaction: {
      aggregate: vi.fn(async () => {
        calls.push('in-flight');

        return { _sum: { amount: options.inFlight ?? null } };
      }),
      create: vi.fn(async () => {
        calls.push('insert');

        if (options.insertError !== undefined) {
          throw options.insertError;
        }

        return row;
      }),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => {
      calls.push('begin');

      const result = await work(tx);

      calls.push('commit');

      return result;
    }),
  };

  /**
   * The queue, as this service sees it: one method, called with the id of the row that was just
   * inserted. `commit` is recorded by the `$transaction` fake above, which is what makes "the job
   * goes on the queue before the transaction commits" an assertion rather than a comment.
   */
  const queue = {
    enqueueSubmission: vi.fn(async (transactionId: string) => {
      calls.push(`enqueue:${transactionId}`);

      if (options.enqueueError !== undefined) {
        throw options.enqueueError;
      }

      return { id: transactionId };
    }),
  };

  const balances = {
    balanceFor: vi.fn(async () => {
      calls.push('balance');

      const wallet = options.wallet === undefined ? '10.0000000' : options.wallet;

      if (wallet instanceof Error) {
        throw wallet;
      }

      if (wallet === null) {
        return walletWith(null);
      }

      return typeof wallet === 'string' ? walletWith(wallet) : wallet;
    }),
  };

  const recipients = {
    assertPayableRecipient: vi.fn(async () => {
      calls.push('recipient');

      if (options.recipient instanceof Error) {
        throw options.recipient;
      }

      return options.recipient ?? { id: RECIPIENT_ID, handle: 'kofi', displayName: null };
    }),
  };

  return {
    calls,
    tx,
    prisma,
    balances,
    recipients,
    queue,
    service: new PaymentsService(
      prisma as unknown as PrismaService,
      balances as unknown as BalancesService,
      recipients as unknown as RecipientsService,
      queue as unknown as PaymentsQueueService,
    ),
  };
}

/** The three arguments `create` takes, with the amount and recipient the tests vary. */
async function create(
  harnessed: ReturnType<typeof harness>,
  overrides: { amount?: string; recipientId?: string } = {},
) {
  return harnessed.service.create(
    SENDER,
    { recipientId: overrides.recipientId ?? RECIPIENT_ID, amount: overrides.amount ?? '10' },
    KEY,
  );
}

/** The status of the failure a promise produced, for the mapping assertions. */
async function failureOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { getStatus?: () => number; message: string };

    return { status: failure.getStatus?.() ?? 0, message: failure.message };
  }

  throw new Error('expected the request to be refused, and it was not');
}
describe('the row it writes', () => {
  it('writes one PENDING row with the canonical amount string and the client key', async () => {
    const harnessed = harness();
    await create(harnessed, { amount: '10.0000000' });

    expect(harnessed.tx.transaction.create).toHaveBeenCalledWith({
      data: {
        senderId: SENDER.id,
        recipientId: RECIPIENT_ID,
        // The shortest exact form: `Amount.toString()`, which is also what JSON carries. A
        // trailing-zero spelling never reaches the column.
        amount: '10',
        idempotencyKey: KEY,
        status: TransactionStatus.PENDING,
      },
      select: { id: true, status: true, amount: true, createdAt: true },
    });
  });

  it('answers from the row it wrote, not from the request', async () => {
    const harnessed = harness({ storedAmount: '0.0000001' });

    const response = await create(harnessed, { amount: '0.0000001' });

    expect(response).toEqual({
      id: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
      status: 'PENDING',
      amount: '0.0000001',
      recipientId: RECIPIENT_ID,
      createdAt: '2026-09-29T16:53:53.412Z',
    });
  });

  it('reads the balance before it opens the transaction, then locks, sums, inserts and enqueues', async () => {
    const harnessed = harness();

    const created = await create(harnessed);

    // The order is the design: the recipient is checked before anything expensive, the network
    // read happens *outside* the lock (a Horizon round trip is not something to hold a row lock
    // across), the sum comes after the lock because that is the read the lock serialises - and the
    // submission job is the last thing before the commit, so a committed row always has one (Step
    // 27; the argument for that ordering is on the call itself).
    expect(harnessed.calls).toEqual([
      'recipient',
      'balance',
      'begin',
      'lock',
      'in-flight',
      'insert',
      `enqueue:${created.id}`,
      'commit',
    ]);

    // And the job names the row the response names: a client that was told about a payment and a
    // queue that was told about a different one would be two payments, not one.
    expect(harnessed.queue.enqueueSubmission).toHaveBeenCalledWith(created.id);
  });

  it('fails the payment when the queue will not take the job, and never reaches the commit', async () => {
    // The bound `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS` puts on a sick Redis, seen from the caller: the
    // rejection travels out of the transaction, the row is rolled back with it, and the sender is
    // told the payment failed rather than being told `202` for a job nobody agreed to run.
    const timeout = new Error('Command timed out');
    const harnessed = harness({ enqueueError: timeout });

    await expect(create(harnessed)).rejects.toBe(timeout);

    expect(harnessed.calls).not.toContain('commit');
  });
});

describe('the amount', () => {
  it('refuses text that is not an amount, with the reason, and writes nothing', async () => {
    for (const amount of ['1.50000000', '-1', '1e3', '1,000', ' 1 ', '', '1.']) {
      const harnessed = harness();
      const failure = await failureOf(create(harnessed, { amount }));

      expect(failure.status).toBe(400);
      expect(failure.message).toMatch(/is not an amount/);
      // Nothing was looked up, locked or written: the amount is the first check because nothing
      // else can be judged before it is known.
      expect(harnessed.calls).toEqual([]);
    }
  });

  it('refuses zero, and says so in the money module word for it', async () => {
    const harnessed = harness();
    const failure = await failureOf(create(harnessed, { amount: '0.0000000' }));

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/a payment of nothing is not a payment/);
    expect(harnessed.calls).toEqual([]);
  });

  it('refuses an amount wider than the column, rather than letting Postgres raise a 500', async () => {
    const harnessed = harness();
    const failure = await failureOf(create(harnessed, { amount: '99999999999999' }));

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/14 integer digits/);
    expect(harnessed.calls).toEqual([]);
  });
});

describe('who may be paid', () => {
  it('lets the shared recipient check decide, and stops there when it refuses', async () => {
    const refusal = new NotFoundException(
      'No Cashping account with that id can receive money. Check the id, or search again.',
    );
    const harnessed = harness({ recipient: refusal });

    const failure = await failureOf(create(harnessed));

    // The 404 is `RecipientsService`'s, unchanged: one sentence for unknown, unverified and
    // suspended, so a payment cannot be used to ask which ids exist. No wallet read happens for a
    // recipient that cannot be paid - and no lock, so an unpayable id costs nothing.
    expect(failure.status).toBe(404);
    expect(failure.message).toBe(refusal.message);
    expect(harnessed.calls).toEqual(['recipient']);
    expect(harnessed.balances.balanceFor).not.toHaveBeenCalled();
  });

  it('refuses a payment to the sender, before any lookup at all', async () => {
    const harnessed = harness();
    const failure = await failureOf(create(harnessed, { recipientId: SENDER.id }));

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/someone else/);
    expect(harnessed.calls).toEqual([]);
  });
});

describe('what the wallet allows', () => {
  it('refuses a wallet with no USDC line, because there is no balance to spend', async () => {
    const harnessed = harness({ wallet: null });

    const failure = await failureOf(create(harnessed));

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/cannot hold USDC/);
    expect(harnessed.calls).toEqual(['recipient', 'balance']);
  });

  it('carries the wrong-issuer / un-CUSDC line through as the same refusal', async () => {
    const harnessed = harness({
      wallet: { ...walletWith('5.0000000'), trustline: 'unauthorized' },
    });

    const failure = await failureOf(create(harnessed));

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/cannot hold USDC/);
  });

  it('propagates the wallet-less 404 and the Horizon-silent 503 unchanged', async () => {
    const noWallet = harness({
      wallet: new NotFoundException('No Stellar account has been provisioned for this user yet.'),
    });
    const noHorizon = harness({
      wallet: new (class HorizonUnavailable extends Error {})(),
    });

    expect((await failureOf(create(noWallet))).status).toBe(404);
    // Anything that is not this service's to classify keeps travelling: a 500 here would be the
    // global filter's business, and `BalancesService` is where Horizon's failure is turned into a
    // 503 - this file only proves the two known refusals are not swallowed.
    expect((await failureOf(create(noHorizon))).status).toBe(0);
  });
});
describe('the overdraft check', () => {
  it('refuses a payment larger than the wallet holds, naming the spendable amount', async () => {
    const harnessed = harness({ wallet: '10.0000000' });

    const failure = await failureOf(create(harnessed, { amount: '10.0000001' }));

    // 409 rather than 400: the request is fine, the account's state is not - and the message
    // carries the number a client renders as "you can send up to X".
    expect(failure.status).toBe(409);
    expect(failure.message).toContain('10');
    expect(harnessed.tx.transaction.create).not.toHaveBeenCalled();
  });

  it('counts money already in flight, which is the half Horizon cannot see', async () => {
    // 10 in the wallet, 6 already committed by a PENDING payment: 5 does not fit, even though it
    // fits in the balance. Without the sum, that is exactly the overdraft the race would produce.
    const harnessed = harness({ wallet: '10.0000000', inFlight: '6.0000000' });

    const failure = await failureOf(create(harnessed, { amount: '5' }));

    expect(failure.status).toBe(409);
    expect(failure.message).toContain('4');
    expect(harnessed.tx.transaction.create).not.toHaveBeenCalled();
  });

  it('allows a payment that fits, including one that spends the balance down to zero', async () => {
    const exact = harness({ wallet: '10.0000000' });
    await expect(create(exact, { amount: '10' })).resolves.toMatchObject({ amount: '10' });

    const withInFlight = harness({ wallet: '10.0000000', inFlight: '6.0000000' });
    await expect(create(withInFlight, { amount: '4' })).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('refuses when the in-flight rows alone exceed the balance, without inserting', async () => {
    // Reachable if Horizon is stale relative to a submitted payment: the answer is a refusal, not
    // a second payment on top of an unexplained state.
    const harnessed = harness({ wallet: '1.0000000', inFlight: '2.0000000' });

    const failure = await failureOf(create(harnessed, { amount: '0.0000001' }));

    expect(failure.status).toBe(409);
    expect(failure.message).toContain('-1');
    expect(harnessed.tx.transaction.create).not.toHaveBeenCalled();
  });
});

describe('the unique index underneath the idempotency claim', () => {
  it('turns a P2002 into a 409 naming the key, instead of a 500', async () => {
    const collision = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.10.0',
    });
    const harnessed = harness({ insertError: collision });

    const failure = await failureOf(create(harnessed));

    // Reaching here means the Redis claim was gone and the database refused the second row: the
    // payment exists, and the client has to be told that rather than told nothing.
    expect(failure.status).toBe(409);
    expect(failure.message).toContain(KEY);
  });

  it('lets every other database error keep travelling to the global filter', async () => {
    const other = new Error('connection terminated unexpectedly');
    const harnessed = harness({ insertError: other });

    await expect(create(harnessed)).rejects.toBe(other);
  });
});
