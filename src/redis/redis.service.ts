import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * The application's Redis connection.
 *
 * Redis is not a cache here, it is state: the OTP request counter (Step 13) is
 * the first thing that has to survive a restart of the process, and the same
 * connection is what the idempotency-key store and the recipients lookup counter
 * use. That is why it is a provider rather than a client created where it
 * happens to be needed.
 *
 * BullMQ is the one Redis consumer that does *not* use this client (Step 26), and
 * the reason is recorded where the decision was made, in `PaymentsQueueModule`:
 * BullMQ needs connections it can block on, which means
 * `maxRetriesPerRequest: null`, and this client's `2` is the deliberate opposite
 * - a command that cannot be served must *reject*, so the rate limiter and the
 * idempotency store fail closed instead of hanging. The two share one thing:
 * `redis.url`.
 *
 * `main.ts` keeps its own short-lived client for the boot-time reachability
 * check on purpose: that probe wants `retryStrategy: () => null` so a dead Redis
 * fails *immediately* at boot, whereas the application client should keep
 * retrying in the background and let the caller decide what a failed command
 * means. Two different jobs, two different configurations - not two
 * inconsistent checks.
 *
 * The URL comes from `ConfigService`, the same validated source Prisma uses, so
 * it cannot drift from what `validation.schema.ts` approved.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('redis.url'), {
      /**
       * A command that cannot be served after this many retries **rejects**
       * rather than queueing forever behind `enableOfflineQueue`. A request that
       * needs Redis must get an answer it can act on: the rate limiter fails
       * closed on a rejection, and a request that hangs is worse than one that
       * says "try again".
       */
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
    });

    // ioredis reports connection trouble out-of-band. Without a listener the
    // 'error' event is unhandled and takes the process down, which is the wrong
    // answer for a dependency the app can lose for a moment.
    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis error - ${error.message}`);
    });
  }

  /**
   * `quit()` flushes what is in flight and closes the socket - the graceful half
   * of what `main.ts`'s probe does with `disconnect()`. `docker stop` relies on
   * the shutdown hook that calls this; if the connection is already broken, the
   * fallback drops it so a bad Redis cannot block the process from exiting.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }

    this.logger.log('Redis client disconnected');
  }
}
