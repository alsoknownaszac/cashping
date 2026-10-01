import { Logger } from '@nestjs/common';
import { type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfirmationSweepResult,
  type PaymentsConfirmationService,
} from '../services/payments-confirmation.service.js';
import { type PaymentsSubmissionService } from '../services/payments-submission.service.js';
import { type SubmissionOutcome } from '../services/payments-submission.service.js';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_CONFIRMATION_JOB,
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueConfirmationResult,
} from './payments-queue.js';
import { PaymentsProcessor } from './payments.processor.js';

/**
 * The worker with BullMQ and Redis taken out of the picture: which job names it answers, what it
 * does with one it does not know, how a submission job reaches the service that decides, and what
 * its two event handlers say.
 *
 * The live proofs are `test/queue.e2e-spec.ts` (a real job, on a real queue, answered by the real
 * worker) and `test/submission.e2e-spec.ts` (a real payment going to Testnet). What this file pins
 * is the part that must be visible without a server: the probe's answer is written by *this* code,
 * an unrecognised job name throws instead of being acknowledged, a submission job with no payment
 * id throws rather than reporting "nothing to do", and a failure or a worker-level error reaches
 * the log rather than passing silently.
 *
 * Step 28 adds the confirmation branch to that list, and it is the shortest branch in the file: one
 * sweep, no payload, and the service's counters handed back as the job's result. What is worth
 * asserting is that the tick runs exactly once per job (the interval is the repetition, not the
 * handler) and that a sweep which cannot read its rows *fails* rather than reporting a quiet minute.
 */

/** The job fields the processor reads, and nothing else - a whole `Job` would be a fixture. */
function job(name: string, fields: { id?: string; attemptsMade?: number; data?: unknown } = {}): Job {
  return { name, attemptsMade: 0, ...fields } as unknown as Job;
}

/** What an accepted submission reports: the shape the job result is built from. */
function accepted(): SubmissionOutcome {
  return { status: 'accepted', stellarTxHash: 'a'.repeat(64), ledger: 1234, detail: null };
}

/** A submission service that records what it was asked and answers with `outcome` (or throws it). */
function fakeSubmissions(outcome: SubmissionOutcome | Error = accepted()) {
  const asked: string[] = [];

  const submit = async (transactionId: string): Promise<SubmissionOutcome> => {
    asked.push(transactionId);

    if (outcome instanceof Error) {
      throw outcome;
    }

    return outcome;
  };

  return { asked, submit };
}

/** One tick's counters, all zero: the shape is what the branch tests are about, not the numbers. */
function sweepResult(overrides: Partial<ConfirmationSweepResult> = {}): ConfirmationSweepResult {
  return {
    polled: 0,
    confirmed: 0,
    failed: 0,
    waiting: 0,
    unresolved: 0,
    stuckWithoutHash: 0,
    ...overrides,
  };
}

/** A sweep that records how often it was asked and answers with `result`. */
function fakeSweeps(result: ConfirmationSweepResult = sweepResult()) {
  const sweeps: Date[] = [];

  const sweep = async (now: Date = new Date()): Promise<ConfirmationSweepResult> => {
    sweeps.push(now);

    return result;
  };

  return { sweeps, sweep };
}

/**
 * One processor over two fakes - a submission service and a confirmation service - because those are
 * the two collaborators it has as of Step 28, and both are injected rather than constructed for the
 * same reason: neither decision is the worker's.
 */
function processor(submissions = fakeSubmissions(), confirmations = fakeSweeps()): {
  processor: PaymentsProcessor;
  asked: string[];
  sweeps: Date[];
} {
  return {
    processor: new PaymentsProcessor(
      { submit: submissions.submit } as unknown as PaymentsSubmissionService,
      { sweep: confirmations.sweep } as unknown as PaymentsConfirmationService,
    ),
    asked: submissions.asked,
    sweeps: confirmations.sweeps,
  };
}

/** One processor whose sweep throws, for the branch a *query* failure takes. */
function processorWithFailingSweep(failure: Error): PaymentsProcessor {
  return new PaymentsProcessor(
    { submit: fakeSubmissions().submit } as unknown as PaymentsSubmissionService,
    {
      sweep: async (): Promise<ConfirmationSweepResult> => {
        throw failure;
      },
    } as unknown as PaymentsConfirmationService,
  );
}

/** One captured `logger.error` call: the message, and the stack passed beside it. */
interface CapturedLog {
  message: string;
  detail: unknown;
}

function captureErrors(): CapturedLog[] {
  const lines: CapturedLog[] = [];

  vi.spyOn(Logger.prototype, 'error').mockImplementation(
    (message: unknown, detail?: unknown): void => {
      lines.push({ message: String(message), detail });
    },
  );

  return lines;
}

describe('PaymentsProcessor.process', () => {
  it('answers a probe with the process that handled it', async () => {
    const result = await processor().processor.process(job(PAYMENTS_QUEUE_PROBE_JOB, { id: '7' }));

    // Exactly two fields, and the pid is *this* process - the worker runs inside the API, so
    // the answer is local by construction. `test/queue.e2e-spec.ts` deliberately does not
    // assert that, and says why: several suites boot this same app at once there.
    expect(result).toEqual({ pong: true, workerPid: process.pid });
  });

  it('hands a submission job to the submission service and reports what it decided', async () => {
    const { processor: worker, asked } = processor();

    const result = await worker.process(
      job(PAYMENTS_QUEUE_SUBMISSION_JOB, {
        id: '12',
        data: { transactionId: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70' },
      }),
    );

    // The id reaches the service - which is where every decision about the payment lives - and the
    // answer the job stores is the service's own, field for field. This assignment is also the
    // compile-time check that the two result types still agree.
    expect(asked).toEqual(['6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70']);
    expect(result).toEqual({
      transactionId: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
      status: 'accepted',
      stellarTxHash: 'a'.repeat(64),
      ledger: 1234,
      detail: null,
    });
  });

  it('refuses a submission job with no payment id instead of reporting nothing to do', async () => {
    const { processor: worker, asked } = processor();

    // A payload this code cannot read is a bug (a hand-written entry, a renamed field, a version
    // skew between deployments), and "there was no payment to submit" is exactly the
    // acknowledgement that would hide it: the job has to fail where somebody can see it.
    await expect(worker.process(job(PAYMENTS_QUEUE_SUBMISSION_JOB, { id: '9' }))).rejects.toThrow(
      'Submission job (id 9) carries no transactionId, so there is no payment to submit',
    );

    expect(asked).toEqual([]);
  });

  it('lets a submission failure travel, so BullMQ prices the attempt', async () => {
    const failure = new Error('Horizon did not answer');
    const { processor: worker } = processor(fakeSubmissions(failure));

    await expect(
      worker.process(job(PAYMENTS_QUEUE_SUBMISSION_JOB, { data: { transactionId: 'tx-1' } })),
    ).rejects.toBe(failure);
  });

  it('runs exactly one sweep for a confirmation job and stores its counters as the result', async () => {
    const counters = sweepResult({ polled: 3, confirmed: 1, failed: 1, waiting: 1 });
    const { processor: worker, sweeps, asked } = processor(
      fakeSubmissions(),
      fakeSweeps(counters),
    );

    const result = await worker.process(job(PAYMENTS_QUEUE_CONFIRMATION_JOB, { id: '77' }));

    // One tick, no payload needed - the work list is the `PROCESSING` rows, read inside the sweep -
    // and no submission: a poller that could submit would be a second path to a signature.
    expect(sweeps).toHaveLength(1);
    expect(asked).toEqual([]);

    // The counters the job stores are the service's own, field for field. This assignment is also
    // the compile-time check that the queue's result type still agrees with the service's.
    const agreed: PaymentsQueueConfirmationResult = counters;
    expect(result).toEqual(agreed);
  });

  it('lets a sweep that cannot read its rows fail the job, so BullMQ owns that retry', async () => {
    const failure = new Error('Prisma: connection refused');

    // A *query* failure is different from a row Horizon cannot answer yet: the service counts and
    // swallows the per-row case (the tick still has other rows to work through), while a tick that
    // cannot read anything throws - and that has to reach BullMQ as a failed job rather than be
    // reported as a tick that found nothing to do.
    await expect(
      processorWithFailingSweep(failure).process(job(PAYMENTS_QUEUE_CONFIRMATION_JOB, { id: '78' })),
    ).rejects.toBe(failure);
  });

  it('refuses a job no handler recognises rather than acknowledging it', async () => {
    // A *near-miss* name, deliberately: a renamed submission job is the most likely way this branch
    // is reached in production, and it must fail loudly rather than be reported as done.
    await expect(
      processor().processor.process(job('submit-payment-legacy', { id: '12' })),
    ).rejects.toThrow(
      `No handler for job "submit-payment-legacy" (id 12) on the "${PAYMENTS_QUEUE}" queue`,
    );
  });

  it('says "unknown" rather than "undefined" for a job with no id', async () => {
    await expect(processor().processor.process(job('anything'))).rejects.toThrow(
      `No handler for job "anything" (id unknown) on the "${PAYMENTS_QUEUE}" queue`,
    );
  });
});

describe('PaymentsProcessor worker events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a failed job with its name, its id and how many attempts it took', () => {
    const logged = captureErrors();
    const error = new Error('Horizon timed out');

    processor().processor.onJobFailed(
      job(PAYMENTS_QUEUE_PROBE_JOB, { id: '7', attemptsMade: 3 }),
      error,
    );

    expect(logged).toEqual([
      {
        message: `Job "${PAYMENTS_QUEUE_PROBE_JOB}" (id 7) failed after 3 attempt(s) - Horizon timed out`,
        detail: error.stack,
      },
    ]);
  });

  it('still logs when BullMQ could not load a job at all', () => {
    const logged = captureErrors();
    const error = new Error('missing job data');

    // The optional job is not defensive padding: BullMQ emits `failed` with no job when the
    // entry on the queue cannot be read, and that case must not turn a log call into a second
    // failure - so the handler is called here with what BullMQ would really pass.
    processor().processor.onJobFailed(undefined, error);

    expect(logged).toEqual([
      {
        message: 'Job "unknown" (id unknown) failed after 0 attempt(s) - missing job data',
        detail: error.stack,
      },
    ]);
  });

  it('logs a worker-level error, which is also what keeps it from killing the process', () => {
    const logged = captureErrors();
    const error = new Error('Connection is closed.');

    // BullMQ emits `error` on the worker from its blocking loop, its connections and its
    // scheduler; an `EventEmitter` with no `error` listener *throws*. This handler existing is
    // what stops a momentary Redis disconnect from taking the API down (see the class
    // docstring), and this test is what stops it being deleted as "just a log line".
    processor().processor.onWorkerError(error);

    expect(logged).toEqual([
      { message: 'Payments worker error - Connection is closed.', detail: error.stack },
    ]);
  });
});
