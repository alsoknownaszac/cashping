import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { type NotificationsService, type PaymentResultNotice } from '../../notifications/notifications.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type TransactionLookupResult } from '../../wallet/stellar/transaction-lookup.js';
import { type StellarService } from '../../wallet/stellar/stellar.service.js';
import {
  CONFIRMATION_SWEEP_BATCH,
  PaymentsConfirmationService,
  STUCK_WITHOUT_HASH_AFTER_MS,
} from './payments-confirmation.service.js';
import { CONFIRMATION_GRACE_MS } from './confirmation-triage.js';

/**
 * The sweep with Postgres, Horizon and the SMS provider taken out of the picture: what it asks for,
 * what it writes, what it tells the sender, and - the half that matters most - what it does *not*.
 *
 * Three kinds of assertion, and each is here for a different reason:
 *
 * - **The query is the work list.** `findMany` is the sweep's whole definition of "in flight"
 *   (`PROCESSING`, with a hash, oldest deadline first, bounded by the batch size), and it is the
 *   one place a mistake would be silent: a filter that let a `PENDING` row in would poll a
 *   transaction nobody built, and one that dropped the hash condition would poll `NULL`.
 * - **Every write is the state machine's.** The two writing decisions end in exactly one
 *   compare-and-set each - `where: { id, status: PROCESSING }` - so the writer is asserted here as
 *   a *call*, which is also how "the sweep cannot resolve an already-answered payment" is checked
 *   from this side.
 * - **The quiet answers stay quiet.** `waiting` and `unknown` write nothing at all, and a row whose
 *   verdict was already written by somebody else must not notify: those are the assertions that
 *   keep a race from becoming a second SMS and a slow payment from becoming a failed one.
 *
 * The live proof - a real transaction on Testnet, polled until it lands - is the Step 28 audit item
 * and needs a network; this file is what can be checked without one.
 */

/** The clock every case uses. */
const NOW = new Date('2026-09-30T12:00:00.000Z');

/** A moment relative to `NOW`, in milliseconds (negative is the past). */
function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

/** One in-flight row, in the shape the sweep's `select` reads it. */
interface FakeRow {
  readonly id: string;
  readonly amount: string;
  readonly stellarTxHash: string | null;
  readonly submissionDeadline: Date | null;
  readonly sender: { readonly phoneNumber: string };
  readonly recipient: { readonly handle: string | null };
}

/** A row that Horizon is about to have an opinion about, ten minutes from its deadline. */
function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    amount: '10.0000000',
    stellarTxHash: HASH,
    submissionDeadline: at(10 * 60_000),
    sender: { phoneNumber: '+254700000001' },
    recipient: { handle: 'bob' },
    ...overrides,
  };
}

/** One recorded compare-and-set: the condition, and the columns it would write. */
interface WriteCall {
  readonly where: { readonly id: string; readonly status?: TransactionStatus };
  readonly data: { readonly status?: TransactionStatus; readonly failureReason?: string };
}

/** The three Prisma calls the sweep makes, recorded. */
function fakePrisma(
  rows: readonly FakeRow[],
  options: { writesLanded?: number; stuck?: number } = {},
) {
  const queries: unknown[] = [];
  const writes: WriteCall[] = [];
  const counts: unknown[] = [];

  const prisma = {
    transaction: {
      findMany: async (args: unknown) => {
        queries.push(args);

        return rows;
      },
      updateMany: async (call: WriteCall) => {
        writes.push(call);

        return { count: options.writesLanded ?? 1 };
      },
      count: async (args: unknown) => {
        counts.push(args);

        return options.stuck ?? 0;
      },
    },
  } as unknown as PrismaService;

  return { prisma, queries, writes, counts };
}

/** `StellarService` with only `lookupTransaction` on it, answering per hash. */
function fakeStellar(answers: Readonly<Record<string, TransactionLookupResult | Error>> = {}) {
  const looked: string[] = [];

  const lookupTransaction = async (hash: string): Promise<TransactionLookupResult> => {
    looked.push(hash);

    const answer = answers[hash] ?? { kind: 'not-found' };

    if (answer instanceof Error) {
      throw answer;
    }

    return answer;
  };

  return { looked, lookupTransaction };
}

/** The provider, with the messages it was asked to send. */
function fakeNotifications(failWith?: Error) {
  const sent: { phoneNumber: string; notice: PaymentResultNotice }[] = [];

  const sendPaymentResult = async (phoneNumber: string, notice: PaymentResultNotice) => {
    if (failWith !== undefined) {
      throw failWith;
    }

    sent.push({ phoneNumber, notice });
  };

  return { sent, sendPaymentResult };
}

/** One service over the three fakes, with everything it touched handed back. */
function sweepOver(
  rows: readonly FakeRow[],
  lookups: Readonly<Record<string, TransactionLookupResult | Error>> = {},
  options: { writesLanded?: number; stuck?: number; notifyFailsWith?: Error } = {},
) {
  const prisma = fakePrisma(rows, options);
  const stellar = fakeStellar(lookups);
  const notifications = fakeNotifications(options.notifyFailsWith);

  return {
    service: new PaymentsConfirmationService(
      prisma.prisma,
      stellar as unknown as StellarService,
      notifications as unknown as NotificationsService,
    ),
    ...prisma,
    ...stellar,
    ...notifications,
  };
}

describe('the work list', () => {
  it('asks for exactly the rows it can poll: PROCESSING, with a hash, oldest deadline first', async () => {
    const { service, queries } = sweepOver([row('tx-1')]);

    await service.sweep(NOW);

    // A filter that let a `PENDING` row in would poll a transaction nobody built; one that dropped
    // the hash condition would poll `NULL`. Both are silent, which is why the query is asserted
    // whole rather than by its parts.
    expect(queries).toEqual([
      {
        where: { status: TransactionStatus.PROCESSING, stellarTxHash: { not: null } },
        select: {
          id: true,
          amount: true,
          stellarTxHash: true,
          submissionDeadline: true,
          sender: { select: { phoneNumber: true } },
          recipient: { select: { handle: true } },
        },
        orderBy: { submissionDeadline: 'asc' },
        take: CONFIRMATION_SWEEP_BATCH,
      },
    ]);
  });

  it('bounds one tick, so a backlog cannot hold the worker for minutes', () => {
    // A tick's duration is (rows x Horizon latency): unbounded, a thousand in-flight payments would
    // delay every submission queued behind them, and the oldest deadlines are the ones that matter.
    expect(CONFIRMATION_SWEEP_BATCH).toBeGreaterThan(0);
    expect(CONFIRMATION_SWEEP_BATCH).toBeLessThanOrEqual(100);
  });

  it('reports a quiet minute as a quiet minute rather than as an error', async () => {
    const { service, writes, sent } = sweepOver([]);

    await expect(service.sweep(NOW)).resolves.toEqual({
      polled: 0,
      confirmed: 0,
      failed: 0,
      waiting: 0,
      unresolved: 0,
      stuckWithoutHash: 0,
    });

    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('counts rows that are PROCESSING with no hash, and touches none of them', async () => {
    const { service, counts, writes } = sweepOver([], {}, { stuck: 3 });

    const result = await service.sweep(NOW);

    expect(result.stuckWithoutHash).toBe(3);

    // Counted by *staleness* (`updatedAt`, not `createdAt`): a row being retried right now is one
    // whose claim was just written. And counted only - a row with no hash has nothing to poll, and
    // re-driving a submission is not a poller's decision to make.
    expect(counts).toEqual([
      {
        where: {
          status: TransactionStatus.PROCESSING,
          stellarTxHash: null,
          updatedAt: { lt: new Date(NOW.getTime() - STUCK_WITHOUT_HASH_AFTER_MS) },
        },
      },
    ]);
    expect(writes).toEqual([]);
  });

  it('skips a row that has lost its hash rather than looking up nothing', async () => {
    const { service, looked } = sweepOver([row('tx-1', { stellarTxHash: null })]);

    await service.sweep(NOW);

    expect(looked).toEqual([]);
  });
});

describe('a payment that landed', () => {
  it("resolves it through the state machine and tells the sender in the row's own words", async () => {
    const { service, writes, sent } = sweepOver([row('tx-1')], {
      [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null },
    });

    await expect(service.sweep(NOW)).resolves.toMatchObject({ polled: 1, confirmed: 1, failed: 0 });

    // One compare-and-set, conditional on the status the row had when it was read: the writer - not
    // this caller's timing - is what makes "exactly one resolution" true when two pollers overlap.
    expect(writes).toEqual([
      {
        where: { id: 'tx-1', status: TransactionStatus.PROCESSING },
        data: { status: TransactionStatus.SUCCESSFUL },
      },
    ]);

    // The message names the amount as stored, read back through the money module rather than echoed
    // from the request: the row holds `10.0000000` and the text carries the canonical `10`, because
    // the one place that decides how an amount is spelled is `Amount`.
    expect(sent).toEqual([
      {
        phoneNumber: '+254700000001',
        notice: { status: 'SUCCESSFUL', amount: '10', recipientHandle: 'bob' },
      },
    ]);
  });

  it('fails one the ledger refused, storing the reason and sending the failure wording', async () => {
    const { service, writes, sent } = sweepOver([row('tx-1')], {
      [HASH]: { kind: 'settled', ledger: 4321, successful: false, transactionCode: 'tx_failed' },
    });

    await expect(service.sweep(NOW)).resolves.toMatchObject({ polled: 1, failed: 1, confirmed: 0 });

    expect(writes).toEqual([
      {
        where: { id: 'tx-1', status: TransactionStatus.PROCESSING },
        data: { status: TransactionStatus.FAILED, failureReason: 'landed-unsuccessful:tx_failed' },
      },
    ]);
    expect(sent[0]?.notice.status).toBe('FAILED');
  });

  it('does not notify a second time when another caller resolved the row first', async () => {
    const { service, sent } = sweepOver(
      [row('tx-1')],
      { [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null } },
      { writesLanded: 0 },
    );

    // Zero rows updated means somebody else's write landed microseconds ago. `false` is not an
    // error - it is why "notify once per resolution" is a property of the database rather than of
    // this caller's timing - and the counters stay at zero, because this tick resolved nothing.
    const result = await service.sweep(NOW);

    expect(sent).toEqual([]);
    expect(result).toMatchObject({ polled: 1, confirmed: 0, failed: 0 });
  });
});

describe('a payment that is not decided yet', () => {
  it('leaves a transaction Horizon has not seen alone while its deadline is ahead', async () => {
    const { service, writes, sent } = sweepOver([row('tx-1')]);

    await expect(service.sweep(NOW)).resolves.toMatchObject({ polled: 1, waiting: 1, failed: 0 });

    // Nothing written and nothing sent: the row stays `PROCESSING` and the next tick asks again.
    // That is the whole difference between a payment that is slow and one that is reported wrongly.
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('fails it once its deadline *and* the grace window have both passed', async () => {
    const { service, writes, sent } = sweepOver([
      row('tx-1', { submissionDeadline: at(-(CONFIRMATION_GRACE_MS + 1)) }),
    ]);

    await expect(service.sweep(NOW)).resolves.toMatchObject({ polled: 1, failed: 1, waiting: 0 });

    // The reason is a machine code, and the notification carries no code at all: the row is where
    // the diagnosis lives, and the message is what the customer needs to know about their money.
    expect(writes).toEqual([
      {
        where: { id: 'tx-1', status: TransactionStatus.PROCESSING },
        data: { status: TransactionStatus.FAILED, failureReason: 'not-found-after-deadline' },
      },
    ]);
    expect(sent[0]?.notice).toEqual({
      status: 'FAILED',
      amount: '10',
      recipientHandle: 'bob',
    });
  });

  it('concludes nothing from a Horizon that did not answer, deadline or no deadline', async () => {
    const { service, writes, sent } = sweepOver(
      [row('tx-1', { submissionDeadline: at(-CONFIRMATION_GRACE_MS * 10) })],
      { [HASH]: { kind: 'unavailable', detail: 'Horizon answered HTTP 503' } },
    );

    await expect(service.sweep(NOW)).resolves.toMatchObject({
      polled: 1,
      unresolved: 1,
      failed: 0,
    });

    // "Could not ask" is not "is not there": reading it as a failure is how a poller fails payments
    // that landed, and the row waits for the next tick instead.
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("failures that must not become the payment's outcome", () => {
  it('keeps the resolution when the sender cannot be told about it', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(message);
    });

    try {
      const { service, writes } = sweepOver(
        [row('tx-1')],
        { [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null } },
        { notifyFailsWith: new Error('provider is down') },
      );

      // The row is written *before* the message is attempted, which is the ordering that matters: a
      // provider outage must not turn a settled payment back into an unsettled one, and it must not
      // make the job fail - which would retry a resolution that is already done.
      await expect(service.sweep(NOW)).resolves.toMatchObject({ confirmed: 1 });

      expect(writes).toHaveLength(1);
      expect(String(logged[0])).toContain('tx-1 is SUCCESSFUL, but the notification could not be sent');
    } finally {
      spy.mockRestore();
    }
  });

  it('counts one unreadable row and still polls the rest of the tick', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(message);
    });

    try {
      const { service, looked, writes } = sweepOver(
        [row('tx-1'), row('tx-2', { stellarTxHash: OTHER_HASH })],
        {
          [HASH]: new Error('malformed hash reached the SDK'),
          [OTHER_HASH]: {
            kind: 'settled',
            ledger: 7,
            successful: true,
            transactionCode: null,
          },
        },
      );

      const result = await service.sweep(NOW);

      expect(result).toMatchObject({ polled: 2, confirmed: 1, unresolved: 1 });
      expect(looked).toEqual([HASH, OTHER_HASH]);
      expect(writes.map((write) => write.where.id)).toEqual(['tx-2']);
      expect(String(logged[0])).toContain('Payment tx-1 could not be polled');
    } finally {
      spy.mockRestore();
    }
  });
});


