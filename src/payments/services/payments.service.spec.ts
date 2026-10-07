import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type BalanceResponseDto } from '../../wallet/dto/balance-response.dto.js';
import { type BalancesService } from '../../wallet/balances/balances.service.js';
import {
  PAYMENT_HISTORY_DEFAULT_LIMIT,
  PAYMENT_HISTORY_MAX_LIMIT,
} from '../history/payment-history-query.js';
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
 *
 * Step 32 adds one more thing to that list, and it is entirely an *order*: `payment.initiated` is
 * appended after the commit above it, and a payment that rolled back is not appended at all. Both
 * halves are asserted here because both are the caller's decision - the entry's columns are
 * `AuditService`'s business.
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

  /**
   * The audit service, as `create` uses it: one method, the entries it was handed, and a marker in
   * `calls` - which is what turns "the entry is written after the commit" into an assertion about
   * the order the steps actually ran in rather than a reading of where the line sits in the file.
   */
  const entries: AuditEntry[] = [];

  const audit = {
    log: vi.fn(async (entry: AuditEntry) => {
      calls.push(`audit:${entry.action}`);
      entries.push(entry);
    }),
  };

  return {
    calls,
    tx,
    prisma,
    balances,
    recipients,
    queue,
    entries,
    audit,
    service: new PaymentsService(
      prisma as unknown as PrismaService,
      balances as unknown as BalancesService,
      recipients as unknown as RecipientsService,
      queue as unknown as PaymentsQueueService,
      audit as unknown as AuditService,
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

    // The status is deliberately absent from the write (Step 29): a payment is created `PENDING` by
    // the column's own `@default(PENDING)`, which is the one place that fact is declared now that
    // status *writes* belong to `transaction-status.ts`. The `select` still reads it back, because
    // the response carries it.
    expect(harnessed.tx.transaction.create).toHaveBeenCalledWith({
      data: {
        senderId: SENDER.id,
        recipientId: RECIPIENT_ID,
        // The shortest exact form: `Amount.toString()`, which is also what JSON carries. A
        // trailing-zero spelling never reaches the column.
        amount: '10',
        idempotencyKey: KEY,
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
      // Step 32 last, and *outside* the transaction on purpose: an entry written inside it would
      // survive a rollback and describe a payment that does not exist (see the call site).
      'audit:payment.initiated',
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
    // And nothing appended (Step 32): the row went back with the transaction, so there is no payment
    // for an entry to describe.
    expect(harnessed.entries).toEqual([]);
  });
});

/**
 * Step 32's one entry from this file, which is the half of it that is this file's to get wrong.
 *
 * The entry's *columns* are `AuditService`'s business (and are pinned in `audit.service.spec.ts`);
 * what only `create` can decide is that the entry exists at all, that it names the three identities
 * a payment has, that its amount agrees with the row, and - the ordering claim - that it is never
 * written for a payment that rolled back.
 */
describe('the audit trail', () => {
  it('appends payment.initiated naming the payment, the payer and the payee', async () => {
    const harnessed = harness({ wallet: '100.0000000', storedAmount: '12.5000000' });

    const created = await create(harnessed, { amount: '12.5' });

    // The amount is the canonical string `Amount` produced, exactly what the row would hold and what
    // the response carries: the trail is written from the same value as the money, so the two cannot
    // disagree about how much was asked for.
    expect(harnessed.entries).toEqual([
      {
        action: 'payment.initiated',
        userId: SENDER.id,
        subjectId: created.id,
        outcome: 'ok',
        metadata: { amount: '12.5', recipientId: RECIPIENT_ID },
      },
    ]);
  });

  it('appends nothing for a payment that was never written', async () => {
    // Both ways a `create` ends without a row: the queue refused the job (the row is rolled back with
    // it) and the database refused the insert - the `P2002` of a retried key, which is the case that
    // proves the entry is downstream of the commit rather than of the insert.
    const refusedByQueue = harness({ enqueueError: new Error('Command timed out') });
    const refusedByDatabase = harness({
      insertError: new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    });

    await expect(create(refusedByQueue)).rejects.toThrow();
    await expect(create(refusedByDatabase)).rejects.toThrow();

    expect(refusedByQueue.entries).toEqual([]);
    expect(refusedByDatabase.entries).toEqual([]);
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

/**
 * Step 30's two reads, with the database substituted: which rows are asked for, what a 404 means,
 * and how a row becomes a response.
 *
 * The claims this step is graded on live in `test/payments-history.e2e-spec.ts` - thirty real rows,
 * real Postgres, every filter and both page boundaries. What is pinned here is the part an e2e is a
 * clumsy witness for: the *shape* of the query (the caller's id is in it, and the read asks for one
 * row more than the page holds), that a filter which cannot be read never reaches the database, and
 * that the two fields a list will not show are not even read.
 */

/**
 * One side of a row as the two reads select it: the id to resolve the account, and the two labels
 * a row can be drawn with.
 */
interface Counterparty {
  id: string;
  handle: string | null;
  displayName: string | null;
}

/** A `transactions` row, as the two reads select it. */
interface HistoryRow {
  id: string;
  senderId: string;
  recipientId: string;
  status: TransactionStatus;
  /** A decimal string: what `Amount.fromDatabase` accepts, and what the driver's `Decimal` reduces to. */
  amount: string;
  createdAt: Date;
  sender: Counterparty;
  recipient: Counterparty;
}

/** The same row plus the two columns only the detail read selects. */
interface DetailedRow extends HistoryRow {
  failureReason: string | null;
  stellarTxHash: string | null;
}

const PAYMENT_ID = '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70';
const TX_HASH = 'e9da1c48bdfaeacd13eb05d1fff82eee4d61d77f0faa467c9d539955bf36ec0d';

/**
 * The handle each fixture account carries, keyed by id.
 *
 * A map rather than two names inlined into `historyRow`, because the same two accounts appear on
 * *both* sides of the rows below - a `received` row's sender is the `sent` row's recipient - and a
 * row built from the ids has to name whichever account actually lands in each column.
 */
const HANDLES: Record<string, string> = {
  [SENDER.id]: 'ama',
  [RECIPIENT_ID]: 'kofi',
};

/**
 * The display name each fixture account carries, keyed by id.
 *
 * A separate map from `HANDLES` because the two columns are nullable apart from each other: the
 * "no handle" case below is one account that has claimed neither, and one test needs an account
 * with a display name and no handle to show the fields do not travel together.
 */
const DISPLAY_NAMES: Record<string, string> = {
  [SENDER.id]: 'Ama Mensah',
  [RECIPIENT_ID]: 'Kofi Boateng',
};

function historyRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  const senderId = overrides.senderId ?? SENDER.id;
  const recipientId = overrides.recipientId ?? RECIPIENT_ID;

  return {
    id: PAYMENT_ID,
    senderId,
    recipientId,
    status: TransactionStatus.SUCCESSFUL,
    amount: '123456789012.1234567',
    createdAt: CREATED_AT,
    sender: {
      id: senderId,
      handle: HANDLES[senderId] ?? null,
      displayName: DISPLAY_NAMES[senderId] ?? null,
    },
    recipient: {
      id: recipientId,
      handle: HANDLES[recipientId] ?? null,
      displayName: DISPLAY_NAMES[recipientId] ?? null,
    },
    ...overrides,
  };
}

function detailedRow(overrides: Partial<DetailedRow> = {}): DetailedRow {
  return { ...historyRow(), failureReason: null, stellarTxHash: null, ...overrides };
}

/** The three fields the counterparty relations are narrowed to. */
const COUNTERPARTY_SELECT = { select: { id: true, handle: true, displayName: true } } as const;

/** The columns the list reads, in one place so the "not even read" assertion is one line. */
const LIST_SELECT = {
  id: true,
  senderId: true,
  recipientId: true,
  status: true,
  amount: true,
  createdAt: true,
  sender: COUNTERPARTY_SELECT,
  recipient: COUNTERPARTY_SELECT,
} as const;

/** What the detail read adds. */
const DETAIL_SELECT = { ...LIST_SELECT, failureReason: true, stellarTxHash: true } as const;

interface ReadHarnessOptions {
  /** What `findFirst` answers - a detail row, or `null` for "not this caller's". */
  row?: DetailedRow | null;
  /** What `findMany` answers, in the order the database would have returned it. */
  rows?: readonly HistoryRow[];
}

/**
 * What a read was asked for, declared so a test can read the arguments back typed.
 *
 * Deliberately loose (`where?: unknown`): the assertions here are about the *shape* a caller chose
 * (`take` one past the page, `select` without the two list-omitted columns), and a typed `where`
 * would make the spec restate Prisma's own types to say nothing.
 */
interface ReadArgs {
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  select?: Record<string, boolean>;
}

/**
 * The two reads, with everything but Prisma real, and the wallet, the recipient check, the queue and
 * the audit service as spies that nothing should reach: a read of a row this API already wrote must
 * not spend an allowance, ask Horizon anything, enqueue a job or append to a table that only ever
 * grows.
 */
function readHarness(options: ReadHarnessOptions = {}) {
  const findOneArgs: ReadArgs[] = [];
  const listArgs: ReadArgs[] = [];

  const findFirst = vi.fn(async (args: ReadArgs) => {
    findOneArgs.push(args);

    return options.row ?? null;
  });

  const findMany = vi.fn(async (args: ReadArgs) => {
    listArgs.push(args);

    return options.rows ?? [];
  });

  const spies = {
    balanceFor: vi.fn(),
    assertPayableRecipient: vi.fn(),
    enqueueSubmission: vi.fn(),
    auditLog: vi.fn(),
  };

  return {
    findFirst,
    findMany,
    findOneArgs,
    listArgs,
    spies,
    service: new PaymentsService(
      { transaction: { findFirst, findMany } } as unknown as PrismaService,
      { balanceFor: spies.balanceFor } as unknown as BalancesService,
      { assertPayableRecipient: spies.assertPayableRecipient } as unknown as RecipientsService,
      { enqueueSubmission: spies.enqueueSubmission } as unknown as PaymentsQueueService,
      { log: spies.auditLog } as unknown as AuditService,
    ),
  };
}

describe('one payment, by id', () => {
  it('asks for the id *and* the caller, in one query', async () => {
    const harnessed = readHarness({ row: detailedRow() });

    await harnessed.service.findOne(SENDER.id, PAYMENT_ID);

    // The caller in the predicate is the whole of the access control: a row two other people are
    // party to matches neither branch, so "not mine" and "does not exist" are one answer. Asserting
    // the arguments rather than only the outcome is what keeps a later refactor from splitting this
    // into "fetch, then compare", where the comparison can be forgotten.
    expect(harnessed.findFirst).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, OR: [{ senderId: SENDER.id }, { recipientId: SENDER.id }] },
      select: DETAIL_SELECT,
    });
  });

  it('answers 404 for a payment that is not the caller\'s, exactly as for one that does not exist', async () => {
    const harnessed = readHarness({ row: null });

    const failure = await failureOf(harnessed.service.findOne(SENDER.id, PAYMENT_ID));

    expect(failure.status).toBe(404);
    expect(failure.message).toContain('No payment with that id involves this account');
  });

  it('reads the amount back from the row, so the response cannot disagree with the column', async () => {
    const harnessed = readHarness({ row: detailedRow({ amount: '0.0000001' }) });

    expect((await harnessed.service.findOne(SENDER.id, PAYMENT_ID)).amount).toBe('0.0000001');
  });

  it('says `sent` to the sender and `received` to the recipient, from the same row', async () => {
    const row = detailedRow();

    expect((await readHarness({ row }).service.findOne(SENDER.id, PAYMENT_ID)).direction).toBe(
      'sent',
    );
    expect(
      (await readHarness({ row }).service.findOne(RECIPIENT_ID, PAYMENT_ID)).direction,
    ).toBe('received');
  });

  it('keeps a missing failure reason as null, and hands a real one back unchanged', async () => {
    const clean = readHarness({ row: detailedRow() });
    const failed = readHarness({
      row: detailedRow({
        status: TransactionStatus.FAILED,
        failureReason: 'landed-unsuccessful:tx_failed',
        stellarTxHash: TX_HASH,
      }),
    });

    expect((await clean.service.findOne(SENDER.id, PAYMENT_ID)).failureReason).toBeNull();

    const response = await failed.service.findOne(SENDER.id, PAYMENT_ID);

    // Verbatim: this layer does not turn a machine code into a sentence, and the hash is present on
    // a FAILED row because a transaction a ledger closed is still a transaction.
    expect(response.failureReason).toBe('landed-unsuccessful:tx_failed');
    expect(response.stellarTxHash).toBe(TX_HASH);
  });

  it('names the counterparty on one payment with the same three fields the list carries', async () => {
    const harnessed = readHarness({ row: detailedRow() });

    const response = await harnessed.service.findOne(SENDER.id, PAYMENT_ID);

    // Same projection as a list row, because both bodies share one DTO: a detail screen and a list
    // label the person identically, and the fields come off the row the read already joined.
    expect(response.counterparty).toEqual({
      id: RECIPIENT_ID,
      handle: 'kofi',
      displayName: 'Kofi Boateng',
    });
  });

  it('reaches no wallet, no allowance, no queue and no audit table', async () => {
    const harnessed = readHarness({ row: detailedRow() });

    await harnessed.service.findOne(SENDER.id, PAYMENT_ID);

    expect(harnessed.spies.balanceFor).not.toHaveBeenCalled();
    expect(harnessed.spies.assertPayableRecipient).not.toHaveBeenCalled();
    expect(harnessed.spies.enqueueSubmission).not.toHaveBeenCalled();
    // A read is not an auditable event (Step 32): the entry that matters for this payment was
    // appended when it was created, and one per lookup would be a row per support request.
    expect(harnessed.spies.auditLog).not.toHaveBeenCalled();
  });
});

describe('a page of history', () => {
  it('asks for one row more than the page holds, newest first', async () => {
    const harnessed = readHarness();

    const page = await harnessed.service.history(SENDER.id, {});

    expect(harnessed.findMany).toHaveBeenCalledWith({
      where: { OR: [{ senderId: SENDER.id }, { recipientId: SENDER.id }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAYMENT_HISTORY_DEFAULT_LIMIT + 1,
      select: LIST_SELECT,
    });
    expect(page).toEqual({ items: [], hasMore: false });
  });

  it('does not even read the two fields a page will not show', async () => {
    const harnessed = readHarness();

    await harnessed.service.history(SENDER.id, {});

    const select = harnessed.listArgs[0]?.select ?? {};

    // The omission is the disclosure decision `PaymentListItemDto` records, enforced where it can
    // be: a column that is never selected cannot reach a page through a later mapper change.
    expect(select).not.toHaveProperty('failureReason');
    expect(select).not.toHaveProperty('stellarTxHash');
    expect(select).toHaveProperty('senderId');
  });

  it('says there is more when the extra row came back, and drops it from the page', async () => {
    const rows = ['a', 'b', 'c'].map((id) => historyRow({ id }));
    const harnessed = readHarness({ rows });

    const page = await harnessed.service.history(SENDER.id, { limit: '2' });

    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(true);
  });

  it('says there is no more when the read ended exactly at the limit', async () => {
    const rows = ['a', 'b', 'c'].map((id) => historyRow({ id }));
    const harnessed = readHarness({ rows });

    const page = await harnessed.service.history(SENDER.id, { limit: '3' });

    expect(page.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(page.hasMore).toBe(false);
  });

  it('maps each row to the caller\'s own side of it', async () => {
    const harnessed = readHarness({
      rows: [
        historyRow({ id: 'sent', senderId: SENDER.id, recipientId: RECIPIENT_ID }),
        historyRow({ id: 'received', senderId: RECIPIENT_ID, recipientId: SENDER.id }),
      ],
    });

    const page = await harnessed.service.history(SENDER.id, {});

    expect(page.items).toEqual([
      {
        id: 'sent',
        status: TransactionStatus.SUCCESSFUL,
        amount: '123456789012.1234567',
        direction: 'sent',
        recipientId: RECIPIENT_ID,
        counterparty: { id: RECIPIENT_ID, handle: 'kofi', displayName: 'Kofi Boateng' },
        createdAt: CREATED_AT.toISOString(),
      },
      {
        id: 'received',
        status: TransactionStatus.SUCCESSFUL,
        amount: '123456789012.1234567',
        direction: 'received',
        recipientId: SENDER.id,
        counterparty: { id: RECIPIENT_ID, handle: 'kofi', displayName: 'Kofi Boateng' },
        createdAt: CREATED_AT.toISOString(),
      },
    ]);
  });

  it('names the account the caller dealt with, and hands an unset label back as null', async () => {
    const harnessed = readHarness({
      rows: [
        // The caller sent this one: the counterparty is the *recipient*.
        historyRow({ id: 'sent', senderId: SENDER.id, recipientId: RECIPIENT_ID }),
        // The caller received this one: the counterparty is the *sender*, and that account has
        // claimed neither a handle nor a display name - both travel as `null` rather than being
        // dropped or defaulted to the id.
        historyRow({
          id: 'received',
          senderId: RECIPIENT_ID,
          recipientId: SENDER.id,
          sender: { id: RECIPIENT_ID, handle: null, displayName: null },
        }),
        // An account that set a display name and no handle: the two columns are nullable apart from
        // each other, so neither may be derived from the other in the response.
        historyRow({
          id: 'half-named',
          senderId: SENDER.id,
          recipientId: RECIPIENT_ID,
          recipient: { id: RECIPIENT_ID, handle: null, displayName: 'Kofi Boateng' },
        }),
      ],
    });

    const page = await harnessed.service.history(SENDER.id, {});

    expect(page.items.map((item) => item.counterparty)).toEqual([
      { id: RECIPIENT_ID, handle: 'kofi', displayName: 'Kofi Boateng' },
      { id: RECIPIENT_ID, handle: null, displayName: null },
      { id: RECIPIENT_ID, handle: null, displayName: 'Kofi Boateng' },
    ]);
  });

  it('refuses a filter it cannot read, before the database is touched', async () => {
    const harnessed = readHarness();

    const failure = await failureOf(harnessed.service.history(SENDER.id, { direction: 'sideways' }));

    expect(failure.status).toBe(400);
    expect(failure.message).toContain('sent, received, both');
    expect(harnessed.findMany).not.toHaveBeenCalled();
  });

  it('passes every filter through as one clause each, and never widens the scope', async () => {
    const harnessed = readHarness();

    await harnessed.service.history(SENDER.id, {
      direction: 'received',
      status: 'FAILED',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      limit: '5',
    });

    expect(harnessed.findMany).toHaveBeenCalledWith({
      where: {
        recipientId: SENDER.id,
        status: 'FAILED',
        createdAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-09-30T23:59:59.999Z'),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 6,
      select: LIST_SELECT,
    });
  });

  it('clamps a page size above the cap instead of refusing it', async () => {
    const harnessed = readHarness();

    await harnessed.service.history(SENDER.id, { limit: '1000' });

    expect(harnessed.listArgs[0]?.take).toBe(PAYMENT_HISTORY_MAX_LIMIT + 1);
  });
});
