import { getQueueToken } from '@nestjs/bullmq';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Job, Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { PAYMENTS_QUEUE } from './../src/payments/jobs/payments-queue.js';
import { PaymentsQueueService } from './../src/payments/jobs/payments-queue.service.js';
import { PaymentsProcessor } from './../src/payments/jobs/payments.processor.js';

/**
 * Step 26's acceptance criterion against the real thing: the queue is registered in the real
 * application and a trivial job round-trips through it - added by the app's own enqueue path,
 * picked up by the app's own worker, answered, and gone again.
 *
 * ## Why the assertions are shaped this way
 *
 * The three things this file asserts are exactly the three that cannot be read off a diff: a
 * queue registered under the wrong name, a worker that never starts, and a worker connected to a
 * *different* Redis all look identical to a working one until something is added to the queue.
 * The round trip is also the strongest form of the "same Redis" claim available at this level -
 * the `QueueEvents` this file builds from the app's own `redis.url` only sees the answer because
 * the app's worker published it to that server.
 *
 * The one thing deliberately **not** asserted is that the answering pid is this process.
 * `workerPid` is reported - it is the probe's diagnostic value, and the reason two consecutive
 * probe answers are worth comparing - but it is only checked to be a live process here, because
 * every e2e file in this repository boots this same application and vitest runs files in
 * parallel: several processes may each have a worker on this queue, BullMQ hands a job to
 * exactly one of them, and *which* one is not a property this step has. Asserting `process.pid`
 * would be a test that passes when run alone and flakes in the suite.
 *
 * ## Running it
 *
 * Local-only, like the other e2e files: it needs the compose stack (`docker compose up -d
 * postgres redis`) plus a `.env`, and it is not part of CI (`npm run test:e2e
 * test/queue.e2e-spec.ts`). No provider is substituted, because nothing in this path needs the
 * outside world - the queue, the worker and the job are all local to Redis.
 */

/** Long enough that a failure means "not consuming", short enough to sit inside vitest's 15s cap. */
const PROBE_TIMEOUT_MS = 10_000;

/** A job name no handler recognises - the "not acknowledged" case, spelled once. */
const UNHANDLED_JOB = 'submit-payment-that-does-not-exist';

let app: INestApplication;
let moduleRef: TestingModule;
/** The app's own queue, reached through the token `PaymentsQueueModule` registered. */
let queue: Queue;
/** Reads the queue's events, so a job's answer can be waited for rather than polled for. */
let queueEvents: QueueEvents;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();

  // `init()` fires the lifecycle hooks, which is where `@nestjs/bullmq` starts the worker - so
  // by the time this returns there is a consumer of this queue in this process.
  await app.init();

  const redisUrl = app.get(ConfigService).getOrThrow<string>('redis.url');

  queue = app.get<Queue>(getQueueToken(PAYMENTS_QUEUE));
  queueEvents = new QueueEvents(PAYMENTS_QUEUE, { connection: { url: redisUrl } });
  await queueEvents.waitUntilReady();
});

afterAll(async () => {
  // The events listener first: it holds its own blocking connection. `app.close()` then closes
  // the worker and the queue (`@nestjs/bullmq`'s shutdown hooks), which is also what keeps
  // vitest from sitting on an open handle.
  await queueEvents.close();
  await app.close();
});

describe('the payments queue', () => {
  it('is registered under its name, with a worker consuming it', async () => {
    expect(queue.name).toBe(PAYMENTS_QUEUE);
    expect(app.get(PaymentsProcessor).worker.isRunning()).toBe(true);
  });

  it('round-trips a probe job enqueued by the application itself', async () => {
    const completedBefore = await queue.getCompletedCount();

    const job = await app.get(PaymentsQueueService).enqueueProbe();
    const answer = await job.waitUntilFinished(queueEvents, PROBE_TIMEOUT_MS);

    // The handler's own answer: the shape is written by the code under test, so getting it back
    // is proof that a worker running *this* codebase handled the job.
    expect(answer.pong).toBe(true);
    expect(answer.workerPid).toBeGreaterThan(0);

    // And it leaves nothing behind - the probe sets `removeOnComplete`, which is what makes it
    // repeatable without growing Redis by one job per question asked.
    expect(await queue.getCompletedCount()).toBe(completedBefore);
  });

  it('fails a job no handler recognises rather than acknowledging it', async () => {
    // `removeOnFail` because the failure is manufactured by this test: leaving it in the failed
    // set would be one more thing for the next run to explain.
    const job: Job = await queue.add(UNHANDLED_JOB, {}, { removeOnFail: true });

    await expect(job.waitUntilFinished(queueEvents, PROBE_TIMEOUT_MS)).rejects.toThrow(
      `No handler for job "${UNHANDLED_JOB}"`,
    );
  });
});
