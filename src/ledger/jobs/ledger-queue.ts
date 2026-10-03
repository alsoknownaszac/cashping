/**
 * The ledger queue's contract (Step 31): its name, its job names, and the shapes those jobs move.
 *
 * One file for the names rather than a string literal in each of the three places that need them -
 * `LedgerQueueModule` registers the queue, `LedgerProcessor` drains it, `LedgerQueueService` adds to
 * it - for exactly the reason `payments-queue.ts` records: a queue name spelled three times is a name
 * that can be spelled wrong once, and that failure is *silent*.
 *
 * BullMQ's own key prefix (default `bull`) is left alone, so everything from this file lands under
 * `bull:ledger:*` in Redis, beside `bull:payments:*`, `otp:requests:*` and `idempotency:*` in the
 * keyspace the app shares. It is a *second* queue rather than a third job on the payments queue
 * because it answers a different question at a different cadence - `payments` is about one payment
 * moving, `ledger` is about every account still agreeing with the network - and a queue that mixes
 * them would have to share a worker's concurrency with a sweep that reads the whole table.
 */

/** The queue's name. What it looks like in Redis is `bull:ledger:*`. */
export const LEDGER_QUEUE = 'ledger';

/**
 * The one job this queue carries: the reconciliation sweep (Step 31).
 *
 * Every tick is the same job with no payload, because a tick's work list is *everything* - the
 * `stellar_accounts` rows, read when the tick runs - so there is nothing a caller could usefully put
 * in it. A payload would be a second, undocumented contract for a job that has no inputs.
 */
export const LEDGER_QUEUE_RECONCILIATION_JOB = 'reconcile-balances';

/**
 * What a reconciliation tick carries: nothing - see `LEDGER_QUEUE_RECONCILIATION_JOB`.
 *
 * `Record<string, never>` rather than `{}` so the compiler rejects anything that tries to smuggle
 * data through it, the same typing the payments probe uses.
 */
export type LedgerQueueReconciliationJobData = Record<string, never>;

/**
 * What one reconciliation tick found, as the job's stored result.
 *
 * Counted rather than summarised into a word, because these are the numbers an operator needs to tell
 * "quiet" from "broken": `drifted > 0` is the alarm, `unavailable > 0` with `compared === 0` is a
 * Horizon that is not answering, and `compared === accounts` on a steady state is a sweep that is
 * actually reaching the network rather than quietly skipping every row.
 */
export interface LedgerQueueReconciliationResult {
  /** `stellar_accounts` rows the tick considered. */
  readonly accounts: number;
  /** Rows with a Horizon answer the internal sum could be measured against. */
  readonly compared: number;
  /** Rows where internal net and Horizon agreed exactly. */
  readonly matched: number;
  /** Rows where they did not - each one logged and reported to Sentry. */
  readonly drifted: number;
  /** Rows Horizon could not answer for: counted, never judged. */
  readonly unavailable: number;
}

/** Every job name on this queue, as one type - which job names exist is a fact about the queue. */
export type LedgerQueueJobName = typeof LEDGER_QUEUE_RECONCILIATION_JOB;

/** The payloads this queue carries, as one type. */
export type LedgerQueueJobData = LedgerQueueReconciliationJobData;

/** The results this queue's jobs produce, as one type. */
export type LedgerQueueJobResult = LedgerQueueReconciliationResult;

/**
 * The job scheduler's id in Redis (`bull:ledger:repeat:<id>`), and the reason the schedule is
 * idempotent: every replica and every restart upserts this one name rather than inventing its own.
 * The same arrangement as the payments queue's `confirmation-sweep`.
 */
export const LEDGER_RECONCILIATION_SCHEDULER_ID = 'reconciliation-sweep';
