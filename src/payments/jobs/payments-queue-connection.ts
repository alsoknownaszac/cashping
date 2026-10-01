import { type ConfigService } from '@nestjs/config';
import { type ConnectionOptions } from 'bullmq';

/**
 * How long one Redis command issued by the payments queue's *producer* may take before it is
 * abandoned (Step 27).
 *
 * Three seconds, and the number is not arbitrary: the command this bounds runs inside the sender's
 * `SELECT ... FOR UPDATE` on `stellar_accounts` (`PaymentsService.create` enqueues before its
 * transaction commits), so its duration *is* the duration of that row lock. A Redis that stops
 * answering would, without this, hold that lock for as long as it stayed quiet - and every other
 * payment from the same sender would queue behind it. Three seconds is long enough for a healthy
 * Redis under load (a single `add` is one Lua script round trip on a local socket) and short
 * enough that the blast radius of a sick one is one failed payment rather than a stalled account.
 * It is also deliberately below Prisma's interactive-transaction timeout (five seconds), so the
 * failure the caller sees is this one - a bound that was chosen - rather than a transaction that
 * timed out underneath it.
 *
 * ## Why this is not on the shared connection
 *
 * `commandTimeout` is an ioredis option, and ioredis arms it for **every** command on the
 * connection with no exemption for blocking ones (`Redis.js`: `command.setTimeout(...)`;
 * `Command.js` rejects with `Command timed out`). The worker's own reads are blocking `BZPOPMIN`
 * calls: `drainDelay` seconds when the queue is idle (five by default), and up to BullMQ's
 * ten-second ceiling when a delayed job is pending - and a job with a backoff *is* a delayed job,
 * so that is the normal case after one retry. A three-second bound on the worker's connection
 * would therefore abort every idle block, and a failed blocking read makes the worker emit `error`
 * and then wait `runRetryDelay` before trying again: an error per idle tick, and submissions
 * waiting seconds behind it. That is a worse availability problem than the one the bound fixes.
 *
 * So the producer gets its own connection (see `PaymentsQueueProducer`) and the worker keeps the
 * shared one, untouched. Two connections is the price of bounding one direction of a queue without
 * breaking the other, and the alternative - one bound that is long enough to clear a ten-second
 * block window - is not a bound worth having on the money path.
 *
 * ## What it does and does not bound
 *
 * It bounds a command ioredis has been handed: one already written to the socket, or one queued
 * while the connection was not writable. It does **not** bound the connection handshake - a Redis
 * that accepts TCP and never completes the handshake leaves BullMQ's `waitUntilReady` unresolved -
 * which is stated here rather than discovered during an incident. What it closes is the case a
 * money path actually meets: a Redis that is reachable but not answering (paused, overloaded, a
 * black-holed established connection). A timed-out command rejects; the connection itself survives,
 * so the failure is one failed payment rather than a poisoned producer.
 */
export const PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS = 3000;

/**
 * The connection the *producer* uses: the same Redis as everything else, with one command bounded.
 *
 * The URL comes from `redis.url` through `ConfigService`, exactly as the shared connection does
 * (`paymentsQueueRootOptions`), because a producer pointed at a different Redis than the worker is
 * the failure this queue's docstring calls out first: a job that is added and never consumed looks
 * identical to a worker that is not running.
 *
 * Handed to BullMQ as a URL plus options rather than as a client, so ioredis is configured the way
 * BullMQ requires for its own connections (`maxRetriesPerRequest: null` on the blocking one) while
 * keeping the one option this step adds. The `commandTimeout` above is the only difference from the
 * shared connection, and that is deliberate: every other setting should be the same or it is not
 * the same Redis.
 */
export function paymentsQueueProducerConnection(config: ConfigService): ConnectionOptions {
  return {
    url: config.getOrThrow<string>('redis.url'),
    commandTimeout: PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS,
  };
}
