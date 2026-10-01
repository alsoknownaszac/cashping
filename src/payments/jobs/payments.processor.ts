import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';
import { PaymentsSubmissionService } from '../services/payments-submission.service.js';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueProbeResult,
  type PaymentsQueueSubmissionJobData,
  type PaymentsQueueSubmissionResult,
} from './payments-queue.js';

/**
 * The worker for the payments queue (Step 26).
 *
 * Nothing here moves money itself, and that is deliberate: this class is the seam between BullMQ
 * and the code that does, and it keeps that seam thin. What Step 27 added is one branch in
 * `process` - a name check, a payload check, and a call to `PaymentsSubmissionService`, which is
 * where every decision about a payment lives. If a reader of this file ever has to think about
 * sequences, deadlines or custody, the boundary has been drawn in the wrong place.
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
   * The submission service is the only collaborator this class has, and it is injected rather than
   * constructed: the decisions about a payment are its, and a worker that could reach past it to a
   * `PrismaService` or a key would be a second place submission logic could grow.
   */
  constructor(
    private readonly submissions: PaymentsSubmissionService,
  ) {
    super();
  }

  /**
   * Handles one job. The return value is what BullMQ stores as the job's result.
   *
   * Three outcomes, and the last is the one that matters:
   *
   * - the probe answers with the process that handled it;
   * - the submission branch hands the payment id to `PaymentsSubmissionService` and returns what it
   *   decided, which is the value an operator reads back from Redis;
   * - **anything else throws**. A job that is acknowledged without being attempted is worse than
   *   one that fails, because a failure is visible and an acknowledgement is not. A submission job
   *   that no handler recognised - renamed on one side, added before its handler exists, or pointed
   *   at the wrong queue - must not be reported as done.
   */
  async process(
    job: Job,
  ): Promise<
    PaymentsQueueProbeResult | PaymentsQueueSubmissionResult
  > {
    if (job.name === PAYMENTS_QUEUE_PROBE_JOB) {
      return { pong: true, workerPid: process.pid };
    }

    if (job.name === PAYMENTS_QUEUE_SUBMISSION_JOB) {
      return this.submit(job);
    }

    throw new Error(
      `No handler for job "${job.name}" (id ${job.id ?? 'unknown'}) on the "${PAYMENTS_QUEUE}" queue`,
    );
  }

  /**
   * The submission branch, guarded by a payload check.
   *
   * A submission job whose payload has no `transactionId` (a hand-written entry, a renamed field, a
   * version skew between two deployments) **throws** rather than being reported as a submission
   * that found nothing to do. The alternative - treating a missing id as "no payment" - is the one
   * failure this whole step cannot afford: a job that claims to have looked and found nothing,
   * while in fact it looked at the wrong thing.
   *
   * The translation from the service's outcome to this queue's result type is a field-for-field
   * assignment, which is deliberate: the compiler fails the build if the two ever disagree about
   * the answers a submission can have.
   */
  private async submit(job: Job): Promise<PaymentsQueueSubmissionResult> {
    const transactionId = (job.data as Partial<PaymentsQueueSubmissionJobData> | undefined)
      ?.transactionId;

    if (typeof transactionId !== 'string' || transactionId === '') {
      throw new Error(
        `Submission job (id ${job.id ?? 'unknown'}) carries no transactionId, so there is no payment to submit`,
      );
    }

    const outcome = await this.submissions.submit(transactionId);

    return {
      transactionId,
      status: outcome.status,
      stellarTxHash: outcome.stellarTxHash,
      ledger: outcome.ledger,
      detail: outcome.detail,
    };
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
