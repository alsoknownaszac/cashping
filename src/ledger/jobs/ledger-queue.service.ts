import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, type JobsOptions, type Queue } from 'bullmq';
import {
  LEDGER_QUEUE,
  LEDGER_QUEUE_RECONCILIATION_JOB,
  LEDGER_RECONCILIATION_SCHEDULER_ID,
  type LedgerQueueJobData,
  type LedgerQueueJobName,
  type LedgerQueueJobResult,
  type LedgerQueueReconciliationJobData,
  type LedgerQueueReconciliationResult,
} from './ledger-queue.js';

/**
 * The API side of the ledger queue (Step 31): everything that puts a reconciliation job *on* it.
 *
 * The same shape as `PaymentsQueueService`, for the same reason: the names and the per-job options
 * have one home, so a caller cannot add an arbitrary name with arbitrary options. What is different
 * is the connection. This service injects the *registered* queue (`@InjectQueue`) rather than owning a
 * `Queue` on a second connection, because nothing here runs inside a row lock - the reason the
 * payments producer needed its own three-second `commandTimeout` does not apply to a sweep - so there
 * is nothing to gain from a second socket and the shared one is the documented default (see
 * `PaymentsQueueModule`'s "registered once" note: a second queue inherits the root connection).
 *
 * It is also where the sweep's one *repeatable* registration lives (`ensureReconciliationScheduler`,
 * called from `onApplicationBootstrap`), for the reason the confirmation sweep's does: a schedule is
 * a policy, and this is the file that holds the queue's policies.
 */
@Injectable()
export class LedgerQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerQueueService.name);

  constructor(
    @InjectQueue(LEDGER_QUEUE)
    private readonly queue: Queue<LedgerQueueJobData, LedgerQueueJobResult, LedgerQueueJobName>,
    /**
     * Read once, at boot, for the sweep's interval. Injected as the service rather than as a number so
     * this file never reads `process.env` directly - the validated configuration is the only place a
     * deployment setting comes from.
     */
    private readonly config: ConfigService,
  ) {}

  /**
   * Registers the reconciliation sweep with BullMQ's job scheduler, if this deployment wants one.
   *
   * A lifecycle hook rather than a constructor body, exactly as the confirmation sweep's is: a
   * scheduler is a Redis write, the queue is connected by then, and a failure here is a *failure to
   * start serving* that Nest surfaces at boot with the rest of the module's initialisation.
   */
  async onApplicationBootstrap(): Promise<void> {
    const intervalMs = this.config.getOrThrow<number>('ledger.reconciliationIntervalMs');

    if (!(await this.ensureReconciliationScheduler(intervalMs))) {
      this.logger.log(
        'The reconciliation sweep is off (ledger.reconciliationIntervalMs=0), so balances are not compared on a schedule - see RECONCILIATION_INTERVAL_MS',
      );
    }
  }

  /**
   * Adds one reconciliation tick and returns it.
   *
   * This is what a human (or a test forcing a mismatch) runs when the schedule is off, when a drift
   * is suspected, or when a deployment wants a comparison without a timer. The payload is empty on
   * purpose: a tick's work list is every account, read when the tick runs.
   */
  async enqueueReconciliation(): Promise<
    Job<LedgerQueueReconciliationJobData, LedgerQueueReconciliationResult>
  > {
    const job = await this.queue.add(
      LEDGER_QUEUE_RECONCILIATION_JOB,
      {},
      reconciliationJobOptions(),
    );

    this.logger.log(`Reconciliation job ${job.id} added to the ${LEDGER_QUEUE} queue`);

    /**
     * The cast is the cost of typing the queue with its job-name union: BullMQ types one
     * payload/result pair per `Queue` instance, and the name and payload here are the pair the other
     * side of the wire handles.
     */
    return job as Job<LedgerQueueReconciliationJobData, LedgerQueueReconciliationResult>;
  }

  /**
   * Registers (or updates) the repeatable reconciliation tick, and answers whether it did.
   *
   * `upsertJobScheduler` rather than an `add` with a `repeat` option, because BullMQ 6 removed the
   * latter: a schedule is now an entity of its own with an id, which is exactly what makes this
   * idempotent. Every instance of this app upserts the *same* id at boot, so a second replica adds no
   * second schedule and a changed interval replaces the old one rather than running beside it.
   *
   * `intervalMs <= 0` means off, and returns `false` rather than registering a zero-delay scheduler
   * (which would be a spin loop): see `DEFAULT_RECONCILIATION_INTERVAL_MS` for why a deployment opts
   * *in* to a process that reads every account from Horizon on a timer.
   */
  async ensureReconciliationScheduler(intervalMs: number): Promise<boolean> {
    if (intervalMs <= 0) {
      return false;
    }

    const next = await this.queue.upsertJobScheduler(
      /**
       * BullMQ 6 types this id as the queue's job-name union (`NameType`), which a scheduler id is
       * not: it lands in Redis as `bull:ledger:repeat:<id>` and may be any name, independently of the
       * job it schedules. The cast is the price of an id that is not also a job name, it is a no-op at
       * runtime, and it is confined to this call - see `LEDGER_RECONCILIATION_SCHEDULER_ID`.
       */
      LEDGER_RECONCILIATION_SCHEDULER_ID as LedgerQueueJobName,
      { every: intervalMs },
      { name: LEDGER_QUEUE_RECONCILIATION_JOB, data: {}, opts: reconciliationJobOptions() },
    );

    this.logger.log(
      `The reconciliation sweep is scheduled every ${intervalMs}ms (next job ${next.id})`,
    );

    return true;
  }
}

/**
 * The options a reconciliation tick is added with, for both the enqueue and the schedule.
 *
 * Deliberately thin, exactly like `confirmationJobOptions()`: **no attempts and no backoff**. A tick
 * that fails is a tick that will run again on the next interval, and the interval *is* the retry
 * policy - adding BullMQ retries on top would mean a failing Horizon is asked twice per interval and
 * the failures multiply across replicas. `removeOnComplete` / `removeOnFail` are `true` for the same
 * reason: the durable record of what a sweep found is the log line and the Sentry event, and a queue
 * that accumulates one entry per interval is a queue whose keyspace grows with time rather than work.
 */
export function reconciliationJobOptions(): JobsOptions {
  return {
    removeOnComplete: true,
    removeOnFail: true,
  };
}
