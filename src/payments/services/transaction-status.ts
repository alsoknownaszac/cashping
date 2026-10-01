import { Prisma } from '../../generated/prisma/client.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';

/**
 * Where a payment may go next (Step 27), as data rather than as prose.
 *
 * The table is the whole state machine, written down in one place, and the point of writing it
 * as a table is that it can be read and tested as one: "can a `FAILED` payment move?" is a
 * lookup here, not an argument about what some future caller might do. Today only Step 27's two
 * writes go through it - `PENDING` to `PROCESSING` when the row is claimed, and `PROCESSING` to
 * `FAILED` when the network gives a definitive no - while `PROCESSING` to `SUCCESSFUL` is
 * Step 28's (the polling job's) and is declared here because it is the *shape* of the column,
 * exactly as the four statuses were declared before anything could write them.
 *
 * ## Why the terminal states have no exits
 *
 * `SUCCESSFUL` and `FAILED` are answers, and a payment whose answer changes is a payment whose
 * history cannot be trusted - the ledger does not un-close a transaction, so nothing above it
 * should be able to. Step 29 is where this stops being a rule the code follows and becomes one
 * the code cannot avoid: the writers at the bottom of this file are the *only* code in the
 * repository that writes the `status` column, and `check-status-discipline.ts` (wired into
 * `npm run lint`) is what makes that a checked property rather than a convention - a
 * `data: { status: ... }` block anywhere else fails the lint with its `file:line`.
 *
 * ## Two layers, and what each one is for
 *
 * The **guards** (`assertTransition`, `canTransition`) refuse an illegal move *before* the
 * database is touched, so a programming error is a stack trace naming the payment rather than a
 * row that quietly disagrees with the design. They are a check, not a lock: nothing stops a
 * second process, which is what BullMQ's stalled-job requeue is.
 *
 * The **conditional write** is the lock. Every writer below is a compare-and-set
 * (`UPDATE ... WHERE id = ... AND status = <expected>`), so of two callers racing to move the
 * same row exactly one updates a row and the other is told `false`. That is the arbiter: the
 * guard's verdict is a preference, the `WHERE` clause's is a fact.
 *
 * ## What the writers deliberately do not do
 *
 * They do not log, they do not notify, they do not decide. Each one performs exactly one
 * transition (or one record change) and answers whether *this* caller's write landed. Anything
 * consequential - a log line, an SMS, a job result - belongs to the caller, because only the
 * caller knows what a lost race should mean: `PaymentsSubmissionService` reports `skipped` and
 * `PaymentsConfirmationService` says nothing at all.
 *
 * ## What this table is not
 *
 * It is not the arbiter of anything. A transition that this table allows can still be refused by
 * the database, and the writes in this codebase *expect* that: every status change is a
 * conditional `UPDATE ... WHERE status = <expected>`, so two workers racing to move the same row
 * means one of them updates zero rows and stops. The guard below is what makes an *illegal*
 * transition a programming error that fails loudly at the point it is written, rather than a
 * write that quietly disagrees with the design.
 */
export const TRANSACTION_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = {
  [TransactionStatus.PENDING]: [TransactionStatus.PROCESSING],
  [TransactionStatus.PROCESSING]: [TransactionStatus.SUCCESSFUL, TransactionStatus.FAILED],
  [TransactionStatus.SUCCESSFUL]: [],
  [TransactionStatus.FAILED]: [],
};

/**
 * A payment was about to be moved somewhere it may not go.
 *
 * A bug rather than a fact about the world, which is why it carries both statuses and the row's
 * id: the message has to say which payment was being moved and from where, or it is a stack
 * trace with no subject. No cause is attached - there is nothing underneath to preserve - and
 * nothing secret can reach it, because no key material goes anywhere near a status write.
 */
export class TransactionTransitionError extends Error {
  constructor(
    readonly transactionId: string,
    readonly from: TransactionStatus,
    readonly to: TransactionStatus,
  ) {
    super(
      `Payment ${transactionId} cannot move from ${from} to ${to} (${TRANSACTION_TRANSITIONS[from].join(', ') || 'nothing'})`,
    );
    this.name = 'TransactionTransitionError';
  }
}

/** Whether the table allows `from` to become `to`. */
export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

/**
 * Whether a status is an answer rather than a state in progress.
 *
 * Asked by the submission handler before it does anything: a job for a payment that is already
 * `SUCCESSFUL` or `FAILED` has no work to do, and the honest report is "skipped" rather than a
 * second attempt at moving money that has already moved (or been refused).
 */
export function isTerminal(status: TransactionStatus): boolean {
  return TRANSACTION_TRANSITIONS[status].length === 0;
}

/** `canTransition`, as the refusal a caller cannot ignore. */
export function assertTransition(
  transactionId: string,
  from: TransactionStatus,
  to: TransactionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new TransactionTransitionError(transactionId, from, to);
  }
}

/**
 * The slice of a Prisma client every writer below needs, and nothing else.
 *
 * Structural rather than `PrismaService`, for two reasons that both matter here: a writer is
 * usable inside a `$transaction` (where the client is a `Prisma.TransactionClient`), and the unit
 * specs can hand it a three-line fake instead of a database. `PrismaService` satisfies it as it
 * stands, because a full client has a superset of these members.
 */
export type TransactionStatusStore = Pick<Prisma.TransactionClient, 'transaction'>;

/**
 * A transaction this app built for a payment, as the row records it.
 *
 * The three values travel together because they are written together: the signed envelope's
 * hash, the sequence number it consumed, and the deadline (`maxTime`) that says how long it may
 * still land. A row holding one without the others was not written by this code - see
 * `recordedTransactionOf` in `PaymentsSubmissionService`, which throws rather than guessing.
 */
export interface RecordedEnvelope {
  readonly hash: string;
  readonly sequence: string;
  readonly deadline: Date;
}

/**
 * `PENDING` to `PROCESSING`: this attempt owns the payment now (Step 27).
 *
 * Conditional on the status still being `PENDING`, which is the whole statement: one row updated
 * means this caller claimed the payment, zero means another attempt or another process got there
 * first and this one must build nothing at all. It is the first write of a submission because
 * everything after it is allowed to be slow.
 */
export async function claimForSubmission(
  store: TransactionStatusStore,
  transactionId: string,
): Promise<boolean> {
  assertTransition(transactionId, TransactionStatus.PENDING, TransactionStatus.PROCESSING);

  const claimed = await store.transaction.updateMany({
    where: { id: transactionId, status: TransactionStatus.PENDING },
    data: { status: TransactionStatus.PROCESSING },
  });

  return claimed.count === 1;
}

/**
 * Records what was signed, *before* Horizon is told anything (Step 27).
 *
 * The condition is the record this attempt read: `stellarTxHash: null` means "no record existed
 * a moment ago", while a hash means a rebuild over exactly that record - so a competing attempt's
 * record makes this update match zero rows, and the caller stops instead of submitting a second
 * live transaction for one payment.
 *
 * Note which column is *not* here: `status`. Recording an envelope does not move the payment; it
 * says which transaction the payment is now committed to, while the status is already
 * `PROCESSING` and stays there until Horizon or the poller answers.
 */
export async function recordEnvelope(
  store: TransactionStatusStore,
  transactionId: string,
  previous: RecordedEnvelope | null,
  written: RecordedEnvelope,
): Promise<boolean> {
  const stored = await store.transaction.updateMany({
    where: {
      id: transactionId,
      status: TransactionStatus.PROCESSING,
      stellarTxHash: previous?.hash ?? null,
    },
    data: {
      stellarTxHash: written.hash,
      stellarTxSequence: written.sequence,
      submissionDeadline: written.deadline,
    },
  });

  return stored.count === 1;
}

/**
 * Puts the previous record back after a rebuild lost to a sequence conflict (Step 27's "restore
 * and stop" rule).
 *
 * Horizon rejecting the *rebuilt* transaction with `tx_bad_seq` means the sequence that was
 * still equal when the attempt loaded the account has since been consumed - which can only be
 * the previously recorded transaction landing in the gap. So the row goes back to naming that
 * transaction, conditional on the hash *this* attempt wrote, so a row another attempt has since
 * recorded is not overwritten. Like `recordEnvelope`, this writes the record and not the status:
 * the payment is still in flight, and the poller now has the hash that landed.
 */
export async function restoreEnvelope(
  store: TransactionStatusStore,
  transactionId: string,
  written: RecordedEnvelope,
  recorded: RecordedEnvelope,
): Promise<boolean> {
  const restored = await store.transaction.updateMany({
    where: {
      id: transactionId,
      status: TransactionStatus.PROCESSING,
      stellarTxHash: written.hash,
    },
    data: {
      stellarTxHash: recorded.hash,
      stellarTxSequence: recorded.sequence,
      submissionDeadline: recorded.deadline,
    },
  });

  return restored.count === 1;
}

/**
 * `PROCESSING` to `FAILED`, with the reason (Steps 27 and 28).
 *
 * Conditional on the status still being `PROCESSING`, which is what keeps a stale conclusion
 * from overwriting a payment someone else has already resolved: zero rows updated means the
 * verdict this caller reached was never written, and the caller reports that honestly rather
 * than claiming a failure the row does not show.
 *
 * The hash the row holds is deliberately left in place. It names a transaction that was built
 * and then refused *at submission*, which is worth keeping: it is the fingerprint of the
 * attempt, and nothing else can collide with it - a different payment has a different
 * destination and amount, and a rebuild consumes a different sequence number. A refused
 * submission is not an absent transaction, either: the hash a `FAILED` row holds very often
 * names an unsuccessful entry in a ledger (see the column's docblock in `schema.prisma`).
 *
 * `reason` is a short machine code (`landed-unsuccessful:op_underfunded`,
 * `not-found-after-deadline`), never prose: see the column's docblock in `schema.prisma` for why
 * Horizon's own wording does not belong in a column that is stored and may be rendered. The
 * prefixes and which code earns which are `submission-triage.ts`'s vocabulary, and they describe
 * whether a ledger closed the transaction rather than who learned the outcome.
 */
export async function markFailed(
  store: TransactionStatusStore,
  transactionId: string,
  reason: string,
): Promise<boolean> {
  assertTransition(transactionId, TransactionStatus.PROCESSING, TransactionStatus.FAILED);

  const failed = await store.transaction.updateMany({
    where: { id: transactionId, status: TransactionStatus.PROCESSING },
    data: { status: TransactionStatus.FAILED, failureReason: reason },
  });

  return failed.count === 1;
}

/**
 * `PROCESSING` to `SUCCESSFUL`: Horizon has the transaction in a closed ledger (Step 28).
 *
 * The same compare-and-set as `markFailed`, and for the same reason: two pollers (two API
 * instances, an overlapping tick) may both read the row as `PROCESSING`, and exactly one of them
 * may be the one that answers it. `false` is therefore not an error - it means somebody else
 * resolved this payment microseconds ago, and it is what makes "notify once per resolution" a
 * property of the database rather than of the caller's timing.
 *
 * Nothing else is cleared. `failureReason` is `NULL` for every row that is not `FAILED` by
 * construction (only `markFailed` sets it, and `FAILED` is terminal), so there is no stale
 * reason to wipe - and a write that touched a column it did not need to would be one more thing
 * a concurrent reader could observe half-done.
 */
export async function markSuccessful(
  store: TransactionStatusStore,
  transactionId: string,
): Promise<boolean> {
  assertTransition(transactionId, TransactionStatus.PROCESSING, TransactionStatus.SUCCESSFUL);

  const successful = await store.transaction.updateMany({
    where: { id: transactionId, status: TransactionStatus.PROCESSING },
    data: { status: TransactionStatus.SUCCESSFUL },
  });

  return successful.count === 1;
}
