import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Job, type JobsOptions } from 'bullmq';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_PRODUCER,
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueHandle,
  type PaymentsQueueProbeJobData,
  type PaymentsQueueProbeResult,
  type PaymentsQueueSubmissionJobData,
  type PaymentsQueueSubmissionResult,
} from './payments-queue.js';

/**
 * The API side of the payments queue (Step 26): everything that puts a job *on* it.
 *
 * A service rather than `@InjectQueue(...) private queue: Queue` wherever a job is needed, for
 * the reason this file exists at all: a caller holding the raw queue can add any name with any
 * options, and nothing stops it - BullMQ's types are per-payload and say nothing about which
 * names have handlers. Here the names and the per-job options have one home, and the day there
 * are two enqueues they are two methods in one file that can be read together.
 *
 * What is deliberately *not* here is the queue's retry *defaults*. The build sequence gated Step 27
 * on a proposal because the payload, the attempts/backoff policy and the retention of a submission
 * job are decisions that interact with idempotency, and a queue with no `defaultJobOptions` is a
 * queue that has made no decision yet - which is the correct state to hand Step 27 rather than a
 * default it would have to notice and argue with. Step 27 kept it that way and put the decision
 * where the job is added instead (`submissionJobOptions`, below), so the two probes and the
 * submission each carry exactly the options it was argued for.
 *
 * Its callers today are the readiness path - `test/queue.e2e-spec.ts`, and the same question
 * asked by hand against a running deployment - and `PaymentsService.create`, which adds a
 * submission job inside its own transaction (`enqueueSubmission` below is that call).
 */
@Injectable()
export class PaymentsQueueService {
  private readonly logger = new Logger(PaymentsQueueService.name);

  constructor(
    @Inject(PAYMENTS_QUEUE_PRODUCER)
    private readonly producer: PaymentsQueueHandle,
  ) {}

  /**
   * Adds the probe job and returns it, so the caller can wait for the worker's answer:
   * `await job.waitUntilFinished(queueEvents)`.
   *
   * `removeOnComplete: true` is set per job rather than on the queue, and it is the promise
   * that makes a probe worth having: it can be fired as often as someone wants to know whether
   * the worker is alive, and each answer disappears as it is read instead of accumulating in
   * Redis. Nothing else is configured - no attempts, no backoff - because a probe that needs
   * retrying is a probe that is telling you something, and that answer is more useful in a log
   * line than hidden behind three silent retries.
   */
  async enqueueProbe(): Promise<Job<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>> {
    const job = await this.queue().add(PAYMENTS_QUEUE_PROBE_JOB, {}, { removeOnComplete: true });

    this.logger.log(`Probe job ${job.id} added to the ${PAYMENTS_QUEUE} queue`);

    /**
     * The cast is the cost of two jobs on one queue: BullMQ types one payload/result pair per
     * `Queue` instance (`Queue<DataType, ResultType, NameType>`), so the producer is typed with
     * this queue's *union* of jobs and each method narrows it back to the one job it adds. It is
     * confined to these two methods, and it is safe by construction: the name and the payload
     * below are the pair the other side of the wire handles.
     */
    return job as Job<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>;
  }

  /**
   * Adds the submission job for one payment (Step 27) and returns it.
   *
   * This is the call `PaymentsService.create` makes *inside* its database transaction, before the
   * commit, which is why it takes no options from its caller and returns immediately: what it adds
   * must not depend on anything that can fail twice. The trade - a rolled-back payment can leave an
   * orphan job - is argued in `docs/step-27-proposal.md` §6, and the handler makes that job fail
   * loudly rather than acknowledge it.
   *
   * ## The job's identity and its options
   *
   * `jobId` is the payment id, so a second job for a payment whose job is still queued is dropped
   * by BullMQ rather than processed twice. That is a *courtesy*, not the guarantee - the guarantee
   * is `PaymentsSubmissionService`, which re-reads the row and let the row decide - because BullMQ
   * forgets a job as soon as its retention policy fires, and the case this step must survive is a
   * re-drive *after* that. Which is also why `removeOnComplete` and `removeOnFail` are `true`: a
   * lingering job under a stable `jobId` would make the next legitimate re-drive a silent no-op,
   * and the durable record of a payment is the row, not a Redis entry.
   *
   * `attempts: 3` with exponential backoff is the retry policy, and it is small on purpose:
   * `StellarSubmissionUnavailableError` is the failure worth retrying, and it resolves or does not
   * within seconds. The backoff (2s, then 4s) stays inside the transaction's own three-minute
   * validity window, so a retry is still a transaction Horizon will accept - and a retry *is* still
   * useful after the first attempt recorded one, because a recorded transaction inside its deadline
   * is deferred to rather than duplicated (the fence).
   */
  async enqueueSubmission(
    transactionId: string,
  ): Promise<Job<PaymentsQueueSubmissionJobData, PaymentsQueueSubmissionResult>> {
    const job = await this.queue().add(
      PAYMENTS_QUEUE_SUBMISSION_JOB,
      { transactionId },
      submissionJobOptions(transactionId),
    );

    this.logger.log(`Submission job ${job.id} added for payment ${transactionId}`);

    return job as Job<PaymentsQueueSubmissionJobData, PaymentsQueueSubmissionResult>;
  }

  /** The producer's queue, typed as this queue's union of jobs. */
  private queue(): PaymentsQueueHandle['queue'] {
    return this.producer.queue;
  }
}

/**
 * The options the submission job is added with (Step 27), in one place so they can be read as a
 * policy rather than as three lines inside a method.
 *
 * Exported for the spec, which asserts them as a whole: the point of the step's proposal was that
 * the retry policy is *decided* rather than inherited, and a `toEqual` over this object is what
 * makes "and nothing else" a fact - a new option appearing here has to be argued with rather than
 * absorbed.
 */
export function submissionJobOptions(transactionId: string): JobsOptions {
  return {
    // One payment, one job id. See `enqueueSubmission` for why this is a courtesy rather than the
    // guarantee.
    jobId: transactionId,
    attempts: 3,
    backoff: { type: 'exponential', delay: SUBMISSION_RETRY_DELAY_MS },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** The first retry's delay; the second is double it. Inside the transaction's validity window. */
const SUBMISSION_RETRY_DELAY_MS = 2000;
