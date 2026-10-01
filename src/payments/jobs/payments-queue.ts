import { type Queue } from 'bullmq';

/**
 * The payments queue's contract: its name, its job names, and the shapes those jobs move
 * (Step 26).
 *
 * One file for the names rather than a string literal in each of the three places that need
 * them - `PaymentsQueueModule` registers the queue, `PaymentsProcessor` drains it,
 * `PaymentsQueueService` adds to it - because a queue name spelled three times is a name that
 * can be spelled wrong once, and that failure is *silent*: a job added to `payment` is a job no
 * worker consumes, which looks exactly like a payment that was queued and never picked up.
 *
 * BullMQ's own key prefix (default `bull`) is left alone, so everything from this file lands
 * under `bull:payments:*` in Redis: one namespace, next to `otp:requests:*` and
 * `idempotency:*` in a keyspace the app shares.
 */

/** The queue's name. What it looks like in Redis is `bull:payments:*`. */
export const PAYMENTS_QUEUE = 'payments';

/**
 * The one job this queue carries as of Step 26: a probe, and the only thing in here that is
 * not about money.
 *
 * It exists because "the queue is registered" is a claim that cannot be read off code - a
 * queue with a worker that never starts, or a worker pointed at a different Redis, looks
 * identical to a working one until a job is added. Adding one and watching a result come back
 * is the difference, and the result is *written by the handler*: getting
 *
 *     { pong: true, workerPid: <n> }
 *
 * back proves four things at once - Redis is reachable, the queue's keys are being written, a
 * worker is consuming, and the code consuming is this code. That makes it the deploy smoke
 * test and the answer to "is the worker alive?" during an incident, rather than a fixture that
 * only a test ever touches. It is deliberately cheap and leaves nothing behind (see
 * `PaymentsQueueService.enqueueProbe`), so it can be fired whenever someone wants to know.
 *
 * It is *not* a placeholder for the submission job and not a stub of it: Step 27 adds a second
 * job with a real payload, and the two coexist (a probe stays useful - it is about the
 * plumbing - while submission is about a payment).
 */
export const PAYMENTS_QUEUE_PROBE_JOB = 'probe';

/**
 * What a probe carries: nothing.
 *
 * Not a stray `any` or an unused field: a probe's whole job is to be *processed*, and an empty
 * payload is the honest type for that. `Record<string, never>` rather than `{}` so the
 * compiler rejects anything that tries to smuggle data through it - a probe with a payload
 * would be a second, undocumented contract.
 */
export type PaymentsQueueProbeJobData = Record<string, never>;

/**
 * What a processed probe answers with - the value a worker returns, which BullMQ stores as the
 * job's return value (`job.waitUntilFinished(...)` hands back exactly this).
 *
 * `workerPid` is the diagnostic half: with more than one process consuming this queue (a second
 * API instance, a separate worker container, or several test suites booting the same app at
 * once) the pid is how you tell *which* consumer answered, and a pid that changes between two
 * probes is how you learn there is more than one.
 */
export interface PaymentsQueueProbeResult {
  pong: true;
  workerPid: number;
}

/**
 * The job that submits a payment (Step 27) - the first thing on this queue that is about money.
 *
 * It coexists with the probe above deliberately: they answer different questions (the probe asks
 * whether the plumbing works, this asks whether a payment moved), and a queue whose only job is a
 * health check is a queue nobody has tested under load.
 */
export const PAYMENTS_QUEUE_SUBMISSION_JOB = 'submit-payment';

/**
 * What a submission job carries: the id of the payment to submit, and nothing else.
 *
 * The payload is deliberately a *reference* rather than a description. Every fact the handler
 * needs - the amount, the two accounts, the record of any transaction already built - is in the
 * `transactions` row, read fresh on each attempt, which is what makes the handler a pure function
 * of that row. Copying any of it into the payload would create a second, older version of the
 * truth, and a job that could disagree with the row it is about.
 */
export interface PaymentsQueueSubmissionJobData {
  readonly transactionId: string;
}

/**
 * What one submission attempt did, as the job's stored result.
 *
 * The five answers are the ones `PaymentsSubmissionService` produces; the union is repeated here
 * rather than imported from the service because this is the *queue's* contract (what a caller
 * reading Redis, or the processor, sees) and the service's is the domain's - and the processor's
 * translation between them is a plain assignment, so the compiler fails the build the day the two
 * drift apart.
 *
 * `detail` is a short machine code, never free text: for a failed payment it is the reason stored
 * in the row (`landed-unsuccessful:op_underfunded`), and for every other answer it names the
 * condition (`recorded-transaction-still-valid`, `claimed-elsewhere`).
 */
export interface PaymentsQueueSubmissionResult {
  readonly transactionId: string;
  readonly status: 'accepted' | 'failed' | 'skipped' | 'deferred' | 'superseded';
  readonly stellarTxHash: string | null;
  readonly ledger: number | null;
  readonly detail: string | null;
}

/** Every job name on this queue, as one type - which job names exist is a fact about the queue. */
export type PaymentsQueueJobName =
  | typeof PAYMENTS_QUEUE_PROBE_JOB
  | typeof PAYMENTS_QUEUE_SUBMISSION_JOB;

/**
 * The payloads this queue carries, as one type.
 *
 * BullMQ types one payload/result pair per `Queue` instance, and this queue carries two jobs, so
 * the honest type at the queue's boundary is a union. The enqueue methods narrow it back to the
 * single job they add (see `PaymentsQueueService`), which is where a caller gets the precision
 * back.
 */
export type PaymentsQueueJobData =
  | PaymentsQueueProbeJobData
  | PaymentsQueueSubmissionJobData;

/** The results this queue's jobs produce, as one type - the result half of the same union. */
export type PaymentsQueueJobResult =
  | PaymentsQueueProbeResult
  | PaymentsQueueSubmissionResult;

/**
 * The producer-side handle on this queue, as the enqueue path needs it.
 *
 * An interface rather than the `PaymentsQueueProducer` class, for a reason that is structural
 * rather than stylistic: `PaymentsQueueService` depends on the producer, the producer is provided
 * by `PaymentsQueueModule`, and that module depends on the service - so injecting the *class* would
 * make the two files import each other and make DI depend on which one ESM happened to evaluate
 * first. The service asks for a token and this shape; the module is free to provide a class that
 * satisfies it (it does, and the shape is one field wide on purpose).
 */
export interface PaymentsQueueHandle {
  readonly queue: Queue<PaymentsQueueJobData, PaymentsQueueJobResult, PaymentsQueueJobName>;
}

/**
 * The token `PaymentsQueueHandle` is provided under (`useExisting: PaymentsQueueProducer`, so both
 * names resolve to the same instance and there is one connection, not two).
 */
export const PAYMENTS_QUEUE_PRODUCER = Symbol('PAYMENTS_QUEUE_PRODUCER');
