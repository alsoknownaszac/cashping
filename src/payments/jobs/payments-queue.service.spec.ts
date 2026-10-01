import { type Job, type JobsOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueHandle,
  type PaymentsQueueProbeJobData,
  type PaymentsQueueProbeResult,
} from './payments-queue.js';
import { PaymentsQueueService, submissionJobOptions } from './payments-queue.service.js';

/**
 * The enqueue path with BullMQ substituted: what is added, with which options, and what a refused
 * `add` does.
 *
 * The options assertions are `toEqual`, not `toMatchObject`, and that is the point of these tests:
 * "the probe sets `removeOnComplete` and **nothing else**" and "the submission job sets exactly
 * these five options" are both claims about *absence*, and only an exact comparison can make them.
 * Step 26 left the retry policy deliberately unwritten; Step 27 wrote it in `submissionJobOptions`,
 * so what is asserted here is that the policy that shipped is the policy that was approved - a
 * sixth option appearing has to be argued with rather than absorbed.
 *
 * The live proof that the path really reaches a worker is `test/queue.e2e-spec.ts` (the probe)
 * and `test/submission.e2e-spec.ts` (the enqueue's bound, against a wedged Redis).
 *
 */

interface AddCall {
  name: string;
  data: unknown;
  options: JobsOptions | undefined;
}

type PaymentsQueue = PaymentsQueueHandle['queue'];

/**
 * The slice of `Queue` this service uses, spelled out so the fake cannot drift from it: if the
 * service starts calling another method, this stops compiling before the test lies.
 */
function fakeQueue(behaviour: { failWith?: Error } = {}) {
  const calls: AddCall[] = [];
  const job = { id: '41' } as unknown as Job<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>;

  const queue = {
    add: async (name: string, data: unknown, options?: JobsOptions) => {
      calls.push({ name, data, options });

      if (behaviour.failWith) {
        throw behaviour.failWith;
      }

      return job;
    },
  } as unknown as PaymentsQueue;

  return { queue, calls, job };
}

/**
 * One service over a fake queue: the two enqueue methods are what this file pins, and the fake is
 * the only collaborator the service has.
 */
function serviceOver(behaviour: { failWith?: Error } = {}) {
  const fake = fakeQueue(behaviour);

  return {
    ...fake,
    service: new PaymentsQueueService({ queue: fake.queue }),
  };
}

describe('PaymentsQueueService.enqueueProbe', () => {
  it('adds the probe job with no payload and no options beyond leaving nothing behind', async () => {
    const { service, calls } = serviceOver();

    await service.enqueueProbe();

    expect(calls).toEqual([
      { name: PAYMENTS_QUEUE_PROBE_JOB, data: {}, options: { removeOnComplete: true } },
    ]);
  });

  it('returns the job, so the caller can wait for the worker to answer it', async () => {
    const { service, job } = serviceOver();

    // This is the seam the e2e uses: `job.waitUntilFinished(queueEvents)` is how the probe's
    // answer is read, so the job object - not just its id - is what this method owes its caller.
    await expect(service.enqueueProbe()).resolves.toBe(job);
  });

  it('lets a refused add reject instead of swallowing it', async () => {
    const failure = new Error('Connection is closed.');
    const { service } = serviceOver({ failWith: failure });

    // Nothing is caught here on purpose: `PaymentsService.create` is the caller that has to turn a
    // failed enqueue into something a user sees, and it can only do that if the rejection travels.
    await expect(service.enqueueProbe()).rejects.toBe(failure);
  });
});

describe('PaymentsQueueService.enqueueSubmission', () => {
  it('adds the payment as a reference, with the approved retry policy and nothing else', async () => {
    const { service, calls } = serviceOver();

    await service.enqueueSubmission('6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70');

    expect(calls).toEqual([
      {
        name: PAYMENTS_QUEUE_SUBMISSION_JOB,
        // The payload is the id and only the id: every fact the handler needs is in the row, read
        // fresh, which is what makes the handler a pure function of that row.
        data: { transactionId: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70' },
        options: submissionJobOptions('6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70'),
      },
    ]);
  });

  it('keys the job on the payment, so one payment is one queued job', () => {
    const transactionId = '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70';

    // The jobId is what makes a double enqueue cheap (BullMQ drops a second job with an id that is
    // still on the queue) and it is deliberately *not* the guarantee: a lingering job under a
    // stable id would block a legitimate re-drive, which is why the job is removed on completion
    // and on failure, and why the row - not this key - is what decides a payment's fate.
    expect(submissionJobOptions(transactionId)).toEqual({
      jobId: transactionId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('lets a refused add reject, which is how a bound on Redis reaches the caller', async () => {
    const failure = new Error('Command timed out');
    const { service } = serviceOver({ failWith: failure });

    // The unit half of the timeout story: whatever ioredis raises when a command is abandoned is
    // not caught, not retried here and not turned into an acknowledgement - it leaves this method
    // as a rejection, so `PaymentsService.create` rolls back instead of answering `202` for a
    // payment nobody is going to submit. The end-to-end half is in `test/submission.e2e-spec.ts`,
    // against a Redis that is actually not answering.
    await expect(service.enqueueSubmission('tx-1')).rejects.toBe(failure);
  });

  it('returns the job, so a caller can follow it rather than guess', async () => {
    const { service, job } = serviceOver();

    await expect(service.enqueueSubmission('tx-1')).resolves.toBe(job);
  });
});

