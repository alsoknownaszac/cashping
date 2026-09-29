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
