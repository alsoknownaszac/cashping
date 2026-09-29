import { Logger } from '@nestjs/common';
import { type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYMENTS_QUEUE, PAYMENTS_QUEUE_PROBE_JOB } from './payments-queue.js';
import { PaymentsProcessor } from './payments.processor.js';

/**
 * Step 26's worker with BullMQ and Redis taken out of the picture: which job names it answers,
 * what it does with one it does not know, and what its two event handlers say.
 *
 * The live proof is `test/queue.e2e-spec.ts` - a real job, on a real queue, answered by the real
 * worker. What this file pins is the part that must be visible without a server: the probe's
 * answer is written by *this* code (the pid is this process), an unrecognised job name throws
 * instead of being acknowledged, and a failure or a worker-level error reaches the log rather
 * than passing silently.
 */

/** The job fields the processor reads, and nothing else - a whole `Job` would be a fixture. */
function job(name: string, fields: { id?: string; attemptsMade?: number } = {}): Job {
  return { name, attemptsMade: 0, ...fields } as unknown as Job;
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
    const result = await new PaymentsProcessor().process(
      job(PAYMENTS_QUEUE_PROBE_JOB, { id: '7' }),
    );

    // Exactly two fields, and the pid is *this* process - the worker runs inside the API, so
    // the answer is local by construction. `test/queue.e2e-spec.ts` deliberately does not
    // assert that, and says why: several suites boot this same app at once there.
    expect(result).toEqual({ pong: true, workerPid: process.pid });
  });

  it('refuses a job no handler recognises rather than acknowledging it', async () => {
    await expect(
      new PaymentsProcessor().process(job('submit-payment', { id: '12' })),
    ).rejects.toThrow(
      `No handler for job "submit-payment" (id 12) on the "${PAYMENTS_QUEUE}" queue`,
    );
  });

  it('says "unknown" rather than "undefined" for a job with no id', async () => {
    await expect(new PaymentsProcessor().process(job('anything'))).rejects.toThrow(
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

    new PaymentsProcessor().onJobFailed(
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
    new PaymentsProcessor().onJobFailed(undefined, error);

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
    new PaymentsProcessor().onWorkerError(error);

    expect(logged).toEqual([
      { message: 'Payments worker error - Connection is closed.', detail: error.stack },
    ]);
  });
});
