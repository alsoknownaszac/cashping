import { type Job, type JobsOptions, type Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  PAYMENTS_QUEUE_PROBE_JOB,
  type PaymentsQueueProbeJobData,
  type PaymentsQueueProbeResult,
} from './payments-queue.js';
import { PaymentsQueueService } from './payments-queue.service.js';

/**
 * Step 26's enqueue path with BullMQ substituted: what is added, with which options, and what a
 * refused `add` does.
 *
 * The options assertion is `toEqual`, not `toMatchObject`, and that is the point of the test:
 * "the probe sets `removeOnComplete` and **nothing else**" - no attempts, no backoff, no delay -
 * so the queue's retry and retention policy is still unwritten (Step 27's proposal owns it) and
 * a default appearing here has to be argued with rather than absorbed. The live proof that this
 * path really reaches a worker is `test/queue.e2e-spec.ts`.
 */

interface AddCall {
  name: string;
  data: unknown;
  options: JobsOptions | undefined;
}

type PaymentsQueue = Queue<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>;

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

describe('PaymentsQueueService.enqueueProbe', () => {
  it('adds the probe job with no payload and no options beyond leaving nothing behind', async () => {
    const { queue, calls } = fakeQueue();

    await new PaymentsQueueService(queue).enqueueProbe();

    expect(calls).toEqual([
      { name: PAYMENTS_QUEUE_PROBE_JOB, data: {}, options: { removeOnComplete: true } },
    ]);
  });

  it('returns the job, so the caller can wait for the worker to answer it', async () => {
    const { queue, job } = fakeQueue();

    // This is the seam the e2e uses: `job.waitUntilFinished(queueEvents)` is how the probe's
    // answer is read, so the job object - not just its id - is what this method owes its caller.
    await expect(new PaymentsQueueService(queue).enqueueProbe()).resolves.toBe(job);
  });

  it('lets a refused add reject instead of swallowing it', async () => {
    const failure = new Error('Connection is closed.');
    const { queue } = fakeQueue({ failWith: failure });

    // Nothing is caught here on purpose: only the caller knows what a failed enqueue means -
    // for a probe it is "the worker cannot be asked right now", and Step 27's caller is the one
    // that will have to turn it into something a user sees, the way `PaymentsService` does for
    // an unreadable idempotency claim.
    await expect(new PaymentsQueueService(queue).enqueueProbe()).rejects.toBe(failure);
  });
});
