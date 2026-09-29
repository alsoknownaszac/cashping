import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { paymentsQueueRootOptions } from './payments-queue.module.js';

/**
 * Step 26's connection decision, pinned in a test rather than left in a comment: the queue runs
 * on the Redis the rest of the app runs on, and on nothing else.
 *
 * Both halves carry weight. The URL half is what stops the queue drifting onto a second Redis -
 * a silent failure, since a job added to one server and a worker waiting on another looks
 * exactly like a worker that is not consuming. The "nothing else" half is what `toEqual` buys
 * here: it asserts the *absence* of `defaultJobOptions` (attempts, backoff, retention), which is
 * this step deliberately handing the retry policy to Step 27's proposal.
 */
describe('paymentsQueueRootOptions', () => {
  it('connects to the Redis the rest of the app uses', () => {
    const config = new ConfigService({ redis: { url: 'redis://cache.internal:6380/3' } });

    expect(paymentsQueueRootOptions(config)).toEqual({
      connection: { url: 'redis://cache.internal:6380/3' },
    });
  });

  it('refuses to guess when the URL is missing, rather than defaulting to localhost', () => {
    // BullMQ's own default is 127.0.0.1:6379, which in a deployed process is a queue that
    // accepts jobs and a worker nobody else can see. Failing here is the point.
    expect(() => paymentsQueueRootOptions(new ConfigService({}))).toThrow(/redis\.url/);
  });
});
