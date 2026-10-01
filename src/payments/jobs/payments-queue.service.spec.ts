import { Logger } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { type Job, type JobsOptions } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  PAYMENTS_QUEUE_CONFIRMATION_JOB,
  PAYMENTS_QUEUE_PROBE_JOB,
  PAYMENTS_QUEUE_SUBMISSION_JOB,
  type PaymentsQueueHandle,
  type PaymentsQueueProbeJobData,
  type PaymentsQueueProbeResult,
} from './payments-queue.js';
import {
  CONFIRMATION_SCHEDULER_ID,
  PaymentsQueueService,
  confirmationJobOptions,
  submissionJobOptions,
} from './payments-queue.service.js';

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
 * The live proof that either path really reaches a worker is `test/queue.e2e-spec.ts` (the probe)
 * and `test/submission.e2e-spec.ts` (the enqueue's bound, against a wedged Redis).
 *
 * Step 28 adds the queue's first *schedule* to the same treatment (`ensureConfirmationScheduler` and
 * the boot hook that calls it), with the scheduler API faked the way `add` is. The policy worth
 * pinning there is a pair of negatives: a deployment whose interval is `0` registers nothing and
 * says so, and a deployment that does poll upserts the *same* id on every replica and restart - a
 * scheduler that quietly ran anyway, or that accumulated one entry per instance, would look exactly
 * like a working one from outside.
 */

interface AddCall {
  name: string;
  data: unknown;
  options: JobsOptions | undefined;
}

/** One captured `upsertJobScheduler` call: the id it upserts, the cadence, and the job it adds. */
interface ScheduleCall {
  id: string;
  repeat: { every?: number };
  template: { name: string; data: unknown; opts: JobsOptions | undefined } | undefined;
}

type PaymentsQueue = PaymentsQueueHandle['queue'];

/**
 * The slice of `Queue` this service uses, spelled out so the fake cannot drift from it: if the
 * service starts calling another method, this stops compiling before the test lies.
 */
function fakeQueue(behaviour: { failWith?: Error } = {}) {
  const calls: AddCall[] = [];
  const schedules: ScheduleCall[] = [];
  const job = { id: '41' } as unknown as Job<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>;

  const queue = {
    add: async (name: string, data: unknown, options?: JobsOptions) => {
      calls.push({ name, data, options });

      if (behaviour.failWith) {
        throw behaviour.failWith;
      }

      return job;
    },
    /**
     * The scheduler API, captured the way `add` is. Nothing is asserted about BullMQ here - what a
     * schedule *is* is the server's business - so the fake records the three arguments and hands
     * back a job, which is all `ensureConfirmationScheduler` reads (`next.id` for its log line).
     */
    upsertJobScheduler: async (
      id: string,
      repeat: { every?: number },
      template?: { name: string; data: unknown; opts: JobsOptions | undefined },
    ) => {
      schedules.push({ id, repeat, template });

      return job;
    },
  } as unknown as PaymentsQueue;

  return { queue, calls, schedules, job };
}

/**
 * One service over a fake queue and a stubbed reader of the one config key it asks for.
 *
 * The config is a stub for the same reason the queue is: what this file pins is which of the
 * service's decisions are *its* (register or not, with which cadence) and which are the
 * deployment's (the number in `.env`). A key the service does not ask for throws, so a new config
 * read cannot arrive unnoticed.
 */
function serviceOver(behaviour: { failWith?: Error; confirmationIntervalMs?: number } = {}) {
  const fake = fakeQueue(behaviour);
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'payments.confirmationIntervalMs') {
        throw new Error(`unexpected config key ${key}`);
      }

      return behaviour.confirmationIntervalMs ?? 0;
    },
  } as unknown as ConfigService;

  return {
    ...fake,
    service: new PaymentsQueueService({ queue: fake.queue }, config),
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

describe('PaymentsQueueService.ensureConfirmationScheduler', () => {
  it('registers nothing when the interval is zero, which is what "off" means here', async () => {
    const { service, schedules } = serviceOver({ confirmationIntervalMs: 0 });

    // The default deployment does not poll: the sweep writes payment verdicts on a timer, so opting
    // in is a deployment's decision, and `0` has to mean "no scheduler at all" rather than a
    // zero-delay one (which would be a spin loop spending money on Horizon calls).
    await expect(service.ensureConfirmationScheduler(0)).resolves.toBe(false);
    expect(schedules).toEqual([]);
  });

  it('upserts one schedule under a stable id, for the job the worker already handles', async () => {
    const { service, schedules } = serviceOver({ confirmationIntervalMs: 30_000 });

    await expect(service.ensureConfirmationScheduler(30_000)).resolves.toBe(true);

    // The stable id is the whole reason for `upsertJobScheduler` over `add({ repeat })`: every
    // replica and every restart writes the *same* Redis key, so a second instance adds no second
    // schedule and a changed interval replaces the old one instead of running beside it. An
    // id per instance - or per boot - would multiply the ticks by the size of the deployment.
    expect(schedules).toEqual([
      {
        id: CONFIRMATION_SCHEDULER_ID,
        repeat: { every: 30_000 },
        template: {
          name: PAYMENTS_QUEUE_CONFIRMATION_JOB,
          data: {},
          opts: confirmationJobOptions(),
        },
      },
    ]);
  });

  it('gives a tick no retry policy of its own - the interval is the retry policy', () => {
    // An exact comparison, so an `attempts` or a `backoff` appearing here has to be argued with: a
    // failing Horizon asked twice per interval, by every replica, is how one outage becomes a storm.
    expect(confirmationJobOptions()).toEqual({ removeOnComplete: true, removeOnFail: true });
  });
});

describe('PaymentsQueueService.onApplicationBootstrap', () => {
  it('schedules the sweep from the configured interval', async () => {
    const { service, schedules } = serviceOver({ confirmationIntervalMs: 15_000 });

    await service.onApplicationBootstrap();

    expect(schedules.map((call) => call.repeat)).toEqual([{ every: 15_000 }]);
  });

  it('says out loud that the sweep is off, so a quiet deployment is a stated choice', async () => {
    const { service, schedules } = serviceOver({ confirmationIntervalMs: 0 });
    const logged: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    try {
      await service.onApplicationBootstrap();
    } finally {
      spy.mockRestore();
    }

    expect(schedules).toEqual([]);

    // The line has to name the config key and point at the README: a deployment where payments sit
    // PROCESSING for ever is a deployment whose log must be able to explain itself, because the
    // alternative is an operator discovering it from a customer.
    expect(logged.join('\n')).toContain('payments.confirmationIntervalMs=0');
    expect(logged.join('\n')).toContain('README');
  });
});
