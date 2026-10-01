import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, type JobsOptions } from 'bullmq';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_CONFIRMATION_JOB,
  PAYMENTS_QUEUE_PRODUCER,
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueConfirmationJobData,
  type PaymentsQueueConfirmationResult,
  type PaymentsQueueHandle,
  type PaymentsQueueJobName,
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
 * are three enqueues they are three methods in one file that can be read together.
 *
 * As of Step 28 it is also where the queue's one *repeatable* job is registered
 * (`ensureConfirmationScheduler`, called from `onApplicationBootstrap`), for the same reason: a
 * schedule is a policy, and this is the file that holds the queue's policies.
 *
 * What is deliberately *not* here is the queue's retry *defaults*. The build sequence gated Step 27
 * on a proposal because the payload, the attempts/backoff policy and the retention of a submission
 * job are decisions that interact with idempotency, and a queue with no `defaultJobOptions` is a
 * queue that has made no decision yet - which is the correct state to hand Step 27 rather than a
 * default it would have to notice and argue with. Step 27 kept it that way and put the decision
 * where the job is added instead (`submissionJobOptions`, below), so the two probes and the
 * submission each carry exactly the options they were argued for. Step 28's confirmation tick does
 * the same (`confirmationJobOptions`).
 *
 * Its callers today are the readiness path - `test/queue.e2e-spec.ts`, and the same question
 * asked by hand against a running deployment - and `PaymentsService.create`, which adds a
 * submission job inside its own transaction (`enqueueSubmission` below is that call).
 */
@Injectable()
export class PaymentsQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsQueueService.name);

  constructor(
    @Inject(PAYMENTS_QUEUE_PRODUCER)
    private readonly producer: PaymentsQueueHandle,
    /**
     * Read once, at boot, for the confirmation sweep's interval (Step 28). Injected as the
     * service rather than as a number so this file never reads `process.env` directly - the
     * validated configuration is the only place a deployment setting comes from.
     */
    private readonly config: ConfigService,
  ) {}

  /**
   * Registers the confirmation sweep with BullMQ's job scheduler, if this deployment wants one.
   *
   * A lifecycle hook rather than a constructor body because a scheduler is a Redis write: the
   * queue is connected by then, and a failure here is a *failure to start serving* rather than a
   * failure to construct a class - Nest surfaces it at boot with the rest of the module's
   * initialisation, which is where an operator should learn it.
   */
  async onApplicationBootstrap(): Promise<void> {
    const intervalMs = this.config.getOrThrow<number>('payments.confirmationIntervalMs');

    if (!(await this.ensureConfirmationScheduler(intervalMs))) {
      this.logger.log(
        'The confirmation sweep is off (payments.confirmationIntervalMs=0), so payments stay PROCESSING until a sweep is run - see the README',
      );
    }
  }

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

  /**
   * Adds one confirmation tick (Step 28) and returns it.
   *
   * This is what a human runs when the sweep is off, when a payment is stuck, or when a
   * deployment wants to poll without a schedule - and it is what the scheduler below adds on a
   * timer. The payload is empty on purpose: a tick's work list is the `PROCESSING` rows, read
   * when the tick runs, so there is nothing a caller could usefully put in it.
   */
  async enqueueConfirmation(): Promise<
    Job<PaymentsQueueConfirmationJobData, PaymentsQueueConfirmationResult>
  > {
    const job = await this.queue().add(
      PAYMENTS_QUEUE_CONFIRMATION_JOB,
      {},
      confirmationJobOptions(),
    );

    this.logger.log(`Confirmation job ${job.id} added to the ${PAYMENTS_QUEUE} queue`);

    return job as Job<PaymentsQueueConfirmationJobData, PaymentsQueueConfirmationResult>;
  }

  /**
   * Registers (or updates) the repeatable confirmation tick, and answers whether it did.
   *
   * `upsertJobScheduler` rather than an `add` with a `repeat` option, because BullMQ 6 removed
   * the latter: a schedule is now an entity of its own with an id, which is exactly what makes
   * this idempotent. Every instance of this app upserts the *same* id at boot, so a second
   * replica adds no second schedule and a changed interval replaces the old one rather than
   * running beside it - and a deployment that restarts does not accumulate ticks.
   *
   * `intervalMs <= 0` means off, and returns `false` rather than registering a zero-delay
   * scheduler (which would be a spin loop): see `DEFAULT_CONFIRMATION_INTERVAL_MS` for why a
   * deployment opts *in* to a process that writes payment verdicts on a timer.
   */
  async ensureConfirmationScheduler(intervalMs: number): Promise<boolean> {
    if (intervalMs <= 0) {
      return false;
    }

    const next = await this.queue().upsertJobScheduler(
      /**
       * BullMQ 6 types this id as the queue's job-name union (`NameType`), which a scheduler id is
       * not: it lands in Redis as `bull:payments:repeat:<id>` and may be any name, independently
       * of the job it schedules. The cast is the price of an id that is not also a job name, it is
       * a no-op at runtime, and it is confined to this call - see `CONFIRMATION_SCHEDULER_ID`.
       */
      CONFIRMATION_SCHEDULER_ID as PaymentsQueueJobName,
      { every: intervalMs },
      { name: PAYMENTS_QUEUE_CONFIRMATION_JOB, data: {}, opts: confirmationJobOptions() },
    );

    this.logger.log(
      `The confirmation sweep is scheduled every ${intervalMs}ms (next job ${next.id})`,
    );

    return true;
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

/**
 * The options a confirmation tick is added with (Step 28), for both the enqueue and the schedule.
 *
 * Deliberately thinner than a submission's: **no attempts and no backoff**. A tick that fails is
 * a tick that will run again on the next interval, and the interval *is* the retry policy - adding
 * BullMQ retries on top would mean a failing Horizon is asked twice per interval and the failures
 * multiply across replicas. The counters in the result are what make a failing tick visible.
 *
 * `removeOnComplete` / `removeOnFail` are `true` for the reason the submission job's are: the
 * durable record of what a tick decided is the `transactions` row and the log line, and a queue
 * that accumulates one entry per interval per payment is a queue whose keyspace grows with time
 * rather than with work.
 */
export function confirmationJobOptions(): JobsOptions {
  return {
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * The job scheduler's id in Redis (`bull:payments:repeat:<id>`), and the reason the schedule is
 * idempotent: every replica and every restart upserts this one name rather than inventing its own.
 */
export const CONFIRMATION_SCHEDULER_ID = 'confirmation-sweep';
