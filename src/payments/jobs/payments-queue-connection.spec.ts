import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import {
  PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS,
  paymentsQueueProducerConnection,
} from './payments-queue-connection.js';

/**
 * Step 27's bound, pinned in a test rather than left in a comment (Step 27).
 *
 * Three assertions, each of which is a decision that must not be able to drift silently:
 *
 * - **The connection is the app's Redis**, because a producer pointed at a different Redis than
 *   the worker is the queue's signature failure: a job that is added and never consumed looks
 *   exactly like a worker that is not running.
 * - **`commandTimeout` is set, is the declared constant, and is the *only* extra option.** The
 *   `toEqual` is what makes "and nothing else" a fact - any second option appearing here would be a
 *   connection decision made in passing.
 * - **The bound is tighter than BullMQ's own blocking window** (its default `drainDelay` is five
 *   seconds, and a command timeout is armed for blocking commands too). That is not a coincidence
 *   to be tuned later; it is the reason this is a *second* connection. If the bound ever reached
 *   the worker's block window, it would either have to live on the shared connection - breaking
 *   every idle worker tick - or stop being a few-second bound on the money path.
 */

/** BullMQ's default `drainDelay`, in milliseconds: the idle worker's blocking window. */
const BULLMQ_DEFAULT_BLOCK_WINDOW_MS = 5000;

describe('paymentsQueueProducerConnection', () => {
  it('connects to the Redis the rest of the app uses, with one command bounded', () => {
    const config = new ConfigService({ redis: { url: 'redis://cache.internal:6380/3' } });

    expect(paymentsQueueProducerConnection(config)).toEqual({
      url: 'redis://cache.internal:6380/3',
      commandTimeout: PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS,
    });
  });

  it('bounds the command in a few seconds, and shorter than a worker block', () => {
    expect(Number.isInteger(PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS)).toBe(true);
    expect(PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS).toBeLessThan(BULLMQ_DEFAULT_BLOCK_WINDOW_MS);
  });

  it('refuses to guess when the URL is missing, rather than defaulting to localhost', () => {
    // The same refusal the shared connection makes, for the same reason: BullMQ's own default is
    // 127.0.0.1:6379, which in a deployed process is a queue that accepts jobs and a worker nobody
    // else can see.
    expect(() => paymentsQueueProducerConnection(new ConfigService({}))).toThrow(/redis\.url/);
  });
});
