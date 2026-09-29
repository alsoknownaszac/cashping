import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_PROBE_JOB,
  type PaymentsQueueProbeResult,
} from './payments-queue.js';

/**
 * The worker for the payments queue (Step 26).
 *
 * Nothing here moves money yet, and that is the whole state of this step: what exists is the
 * plumbing a submission will run on - a queue, a consumer, and one handler that proves the two
 * are talking - and the single handler below is that proof. Step 27 adds the submission
 * handler to this class, which is the step the build sequence gates on a proposal.
 *
 * ## Where the worker runs
 *
 * Inside the API process. That is a choice with visible costs, taken because the alternative
 * (a second deployable: same image, different entrypoint, no HTTP listener) buys nothing at one
 * payment at a time and costs a second thing to keep alive, monitor and configure:
 *
 * - Restarting or redeploying the API restarts the worker. A job that is mid-flight when the
 *   process dies is picked up again by BullMQ's stalled-job check (the lock stops being
 *   renewed, and the job is moved back to `waiting` - `maxStalledCount`, 1 by default, is how
 *   many times that may happen before it is failed instead). That is the exact behaviour Step
 *   27's proposal has to reason about, because "the job ran again" and "the payment was
 *   submitted twice" are different questions with the same trigger.
 * - Scaling the API to N instances scales the consumers to N. Not a correctness problem -
 *   BullMQ hands one job to exactly one consumer - but it is why concurrency is left at
 *   BullMQ's default of 1 here: how many submissions may be in flight at once is a decision
 *   about signing and about Horizon, and it belongs to Step 27's proposal, not to this file.
 *
 * ## What is registered here
 *
 * Two worker event handlers, and both are load-bearing:
 *
 * - `failed` is the job-level failure: the job threw or exceeded its attempts. Logged with the
 *   job's name, id and attempt count, because a failed job that is not in a log is invisible -
 *   it sits in Redis until its retention policy deletes it, and nothing in the HTTP path (the
 *   global exception filter, Sentry's Nest integration) ever sees it. What a failed *payment*
 *   should additionally report is Step 27's question, and this is where it gets answered.
 * - `error` is the worker-level failure, and it is also a crash guard. BullMQ emits `error` on
 *   the worker from many paths - its blocking run loop, connection failures, scheduling - and
 *   an `EventEmitter` with no `error` listener *throws*: a momentary Redis disconnect would
 *   take down the API process. Registering this handler is what turns that into a log line.
 */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsProcessor.name);

  /**
   * Handles one job. The return value is what BullMQ stores as the job's result.
   *
   * An unknown job name **throws** rather than returning quietly, and the reason is the whole
   * discipline of this queue: a job that is acknowledged without being attempted is worse than
   * one that fails, because a failure is visible and an acknowledgement is not. A submission
   * job that no handler recognised - renamed on one side, added before its handler exists, or
   * pointed at the wrong queue - must not be reported as done.
   */
  async process(job: Job): Promise<PaymentsQueueProbeResult> {
    if (job.name === PAYMENTS_QUEUE_PROBE_JOB) {
      return { pong: true, workerPid: process.pid };
    }

    throw new Error(
      `No handler for job "${job.name}" (id ${job.id ?? 'unknown'}) on the "${PAYMENTS_QUEUE}" queue`,
    );
  }

  /**
   * A job failed. `job` is absent when BullMQ could not even load one (a malformed entry on the
   * queue, deleted between reads), which is why it is optional here: that case still has to be
   * logged rather than turning a log call into a second failure.
   */
  @OnWorkerEvent('failed')
  onJobFailed(job: Job | undefined, error: Error): void {
    const name = job?.name ?? 'unknown';
    const id = job?.id ?? 'unknown';
    const attempts = job?.attemptsMade ?? 0;

    this.logger.error(
      `Job "${name}" (id ${id}) failed after ${attempts} attempt(s) - ${error.message}`,
      error.stack,
    );
  }

  /** The worker itself errored - see the class docstring for why this handler must exist. */
  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`Payments worker error - ${error.message}`, error.stack);
  }
}
