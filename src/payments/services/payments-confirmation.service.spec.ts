import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
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
 * - **The audit entries follow the write.** Step 32 appends exactly one entry per resolution, under
 *   the same winner-takes-the-write rule the message follows: the tick that lost the compare-and-set
 *   records nothing, and a tick that decided nothing records nothing. What the *insert* does is
 *   `audit.service.spec.ts`, and whether the table really refuses an `UPDATE` is the migration's
 *   trigger - so what is asserted here is the part only this class can get wrong.
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

/** The sender of every fake row: the actor Step 32's entries are attributed to. */
const SENDER_ID = '2c9d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

/** One in-flight row, in the shape the sweep's `select` reads it. */
interface FakeRow {
  readonly id: string;
  readonly senderId: string;
  readonly amount: string;
  readonly stellarTxHash: string | null;
  readonly submissionDeadline: Date | null;
  readonly sender: {
    readonly phoneNumber: string;
    readonly email: string | null;
    readonly emailVerifiedAt: Date | null;
  };
  readonly recipient: { readonly handle: string | null };
}

/** A row that Horizon is about to have an opinion about, ten minutes from its deadline. */
function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    senderId: SENDER_ID,
    amount: '10.0000000',
    stellarTxHash: HASH,
    submissionDeadline: at(10 * 60_000),
    sender: { phoneNumber: '+254700000001', email: null, emailVerifiedAt: null },
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
  /** Step 34c: the addresses receipts were *also* emailed to, when the address was verified. */
  const emailed: string[] = [];

  const sendPaymentResult = async (
    phoneNumber: string,
    notice: PaymentResultNotice,
    email: string | null = null,
  ) => {
    if (failWith !== undefined) {
      throw failWith;
    }

    sent.push({ phoneNumber, notice });

    if (email !== null) {
      emailed.push(email);
    }
  };

  return { sent, emailed, sendPaymentResult };
}

/**
 * `AuditService`, as this class uses it: one method, and the entries it was handed.
 *
 * The fake records where the real one inserts, which is the only difference: what Step 32 has to
 * prove *from here* is which entries a tick writes and when, while the insert itself - and its
 * refusal to throw - belongs to `audit.service.spec.ts`.
 */
function fakeAudit() {
  const entries: AuditEntry[] = [];

  const log = async (entry: AuditEntry): Promise<void> => {
    entries.push(entry);
  };

  return { entries, log };
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
  const audit = fakeAudit();

  return {
    service: new PaymentsConfirmationService(
      prisma.prisma,
      stellar as unknown as StellarService,
      notifications as unknown as NotificationsService,
      audit as unknown as AuditService,
    ),
    ...prisma,
    ...stellar,
    ...notifications,
    ...audit,
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
          senderId: true,
          amount: true,
          stellarTxHash: true,
          submissionDeadline: true,
          sender: { select: { phoneNumber: true, email: true, emailVerifiedAt: true } },
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
    const { service, writes, sent, entries } = sweepOver([row('tx-1')], {
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

    // Step 32's entry, and its shape is the decision: the actor is the sender's *id* rather than the
    // phone number the message uses (the table points at `users`, which is what makes an entry
    // traceable to an account and not just to a number), the subject is the payment, and the ledger
    // is the one piece of network context an operator would ask for from a settled payment.
    expect(entries).toEqual([
      {
        action: 'payment.completed',
        userId: SENDER_ID,
        subjectId: 'tx-1',
        outcome: 'ok',
        metadata: { ledger: 4321 },
      },
    ]);
  });

  it('fails one the ledger refused, storing the reason and sending the failure wording', async () => {
    const { service, writes, sent, entries } = sweepOver([row('tx-1')], {
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

    // The other half of the pair, carrying the reason the row was given: the same string, decided by
    // the same function, so the trail and the `failure_reason` column cannot disagree about why.
    expect(entries).toEqual([
      {
        action: 'payment.failed',
        userId: SENDER_ID,
        subjectId: 'tx-1',
        outcome: 'failed',
        metadata: { reason: 'landed-unsuccessful:tx_failed' },
      },
    ]);
  });

  it('does not notify a second time when another caller resolved the row first', async () => {
    const { service, sent, entries } = sweepOver(
      [row('tx-1')],
      { [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null } },
      { writesLanded: 0 },
    );

    // Zero rows updated means somebody else's write landed microseconds ago. `false` is not an
    // error - it is why "notify once per resolution" is a property of the database rather than of
    // this caller's timing - and the counters stay at zero, because this tick resolved nothing.
    const result = await service.sweep(NOW);

    expect(sent).toEqual([]);
    // The audit entry is the second thing the lost tick must not produce, for the same reason: a row
    // appended here would claim this tick resolved a payment that somebody else's write resolved.
    expect(entries).toEqual([]);
    expect(result).toMatchObject({ polled: 1, confirmed: 0, failed: 0 });
  });
});

describe('a payment that is not decided yet', () => {
  it('leaves a transaction Horizon has not seen alone while its deadline is ahead', async () => {
    const { service, writes, sent, entries } = sweepOver([row('tx-1')]);

    await expect(service.sweep(NOW)).resolves.toMatchObject({ polled: 1, waiting: 1, failed: 0 });

    // Nothing written and nothing sent: the row stays `PROCESSING` and the next tick asks again.
    // That is the whole difference between a payment that is slow and one that is reported wrongly.
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
    // And nothing appended (Step 32): an entry is a record that a payment was *decided*, so a tick
    // that decided nothing has nothing to record - the same reason it sends nothing.
    expect(entries).toEqual([]);
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

describe('the receipt email (Step 34c)', () => {
  it('emails a verified address as well as texting, and texts alone when the address is unproved', async () => {
    const verified = sweepOver(
      [
        row('tx-1', {
          sender: {
            phoneNumber: '+254700000001',
            email: 'miriam@example.com',
            emailVerifiedAt: new Date(),
          },
        }),
      ],
      { [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null } },
    );

    await verified.service.sweep(NOW);

    expect(verified.sent).toHaveLength(1);
    expect(verified.emailed).toEqual(['miriam@example.com']);

    const unverified = sweepOver(
      [
        row('tx-2', {
          sender: {
            phoneNumber: '+254700000002',
            email: 'typo@example.com',
            emailVerifiedAt: null,
          },
        }),
      ],
      { [HASH]: { kind: 'settled', ledger: 4322, successful: true, transactionCode: null } },
    );

    await unverified.service.sweep(NOW);

    expect(unverified.sent).toHaveLength(1);
    // Attached but unproved: nobody has shown they can read that mailbox, so no receipt goes to it.
    expect(unverified.emailed).toEqual([]);
  });
});

describe("failures that must not become the payment's outcome", () => {
  it('keeps the resolution when the sender cannot be told about it', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(message);
    });

    try {
      const { service, writes, entries } = sweepOver(
        [row('tx-1')],
        { [HASH]: { kind: 'settled', ledger: 4321, successful: true, transactionCode: null } },
        { notifyFailsWith: new Error('provider is down') },
      );

      // The row is written *before* the message is attempted, which is the ordering that matters: a
      // provider outage must not turn a settled payment back into an unsettled one, and it must not
      // make the job fail - which would retry a resolution that is already done.
      await expect(service.sweep(NOW)).resolves.toMatchObject({ confirmed: 1 });

      expect(writes).toHaveLength(1);
      // The same ordering, one step on: the audit entry is written *before* the notification too, so
      // a provider that is down costs the message and not the record of the settlement.
      expect(entries.map((entry) => entry.action)).toEqual(['payment.completed']);
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


