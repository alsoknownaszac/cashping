import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';
import { ReconciliationService } from '../services/reconciliation.service.js';
import {
  LEDGER_QUEUE,
  LEDGER_QUEUE_RECONCILIATION_JOB,
  type LedgerQueueReconciliationResult,
} from './ledger-queue.js';

/**
 * The worker for the ledger queue (Step 31).
 *
 * Thin on purpose, exactly like `PaymentsProcessor`: this class is the seam between BullMQ and the
 * code that does the work, and it keeps that seam thin. The one branch in `process` calls
 * `ReconciliationService.sweep()`, which is where every decision about what a drift is lives. If a
 * reader of this file ever has to think about Horizon, amounts or accounts, the boundary has been
 * drawn in the wrong place.
 *
 * The two worker event handlers are the same crash guards the payments worker registers, and they are
 * load-bearing here for the same reasons: a failed job is invisible to the HTTP path (no request, no
 * global filter), so it is logged with its name and attempt count; and BullMQ emits `error` from many
 * paths, which an `EventEmitter` with no listener turns into a thrown exception that would take the
 * API process down.
 */
@Processor(LEDGER_QUEUE)
export class LedgerProcessor extends WorkerHost {
  private readonly logger = new Logger(LedgerProcessor.name);

  constructor(
    /**
     * The sweep is the only collaborator this class has, and it is injected rather than constructed:
     * the decisions about a drift are its, and a worker that could reach past it to a `PrismaService`
     * or a Horizon client would be a second place reconciliation logic could grow.
     */
    private readonly reconciliations: ReconciliationService,
  ) {
    super();
  }

  /**
   * Handles one job. The return value is what BullMQ stores as the job's result.
   *
   * A job that is not the reconciliation tick **throws**: a job acknowledged without being attempted
   * is worse than one that fails, because a failure is visible and an acknowledgement is not.
   */
  async process(job: Job): Promise<LedgerQueueReconciliationResult> {
    if (job.name === LEDGER_QUEUE_RECONCILIATION_JOB) {
      return this.reconciliations.sweep();
    }

    throw new Error(
      `No handler for job "${job.name}" (id ${job.id ?? 'unknown'}) on the "${LEDGER_QUEUE}" queue`,
    );
  }

  /**
   * A job failed. `job` is absent when BullMQ could not even load one (a malformed entry on the queue,
   * deleted between reads), which is why it is optional here: that case still has to be logged rather
   * than turning a log call into a second failure.
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
    this.logger.error(`Ledger worker error - ${error.message}`, error.stack);
  }
}
