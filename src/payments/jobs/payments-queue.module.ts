import { BullModule, type BullRootModuleOptions } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsProcessor } from './payments.processor.js';
import { PAYMENTS_QUEUE } from './payments-queue.js';
import { PaymentsQueueService } from './payments-queue.service.js';

/**
 * Everything about the payments queue that is not payment logic (Step 26): the connection it
 * runs on, the queue itself, the worker that drains it, and the one service that adds to it.
 *
 * This is `payments/jobs/` finally having contents - the directory the build sequence's file
 * tree reserved for processors, empty until there was something worth queuing. It is a module
 * of its own rather than a handful of imports in `PaymentsModule` because the dependency only
 * ever points one way: this file knows nothing about payments' services, controllers or DTOs, so
 * nothing here can grow into them, and Step 27's submission handler can depend on
 * `SeedCustodyService` and `StellarService` without dragging the module wiring into a file whose
 * job is HTTP.
 *
 * ## Why BullMQ does not share `RedisService`'s client
 *
 * It cannot, and the failure is instructive rather than arbitrary. BullMQ opens connections it
 * *blocks* on (`BRPOPLPUSH`-style waits for the worker, pub/sub for events), and for those
 * ioredis must be configured with `maxRetriesPerRequest: null`; handed a client without it,
 * BullMQ throws outright, and handed an ioredis client with a `keyPrefix` it throws too. This
 * app's client sets `maxRetriesPerRequest: 2` on purpose - a command that cannot be served must
 * *reject*, because the rate limiter and the idempotency store both fail closed on that
 * rejection. Loosening it to `null` for BullMQ's sake would turn those into requests that hang
 * forever, waiting on a Redis that is not answering.
 *
 * So: the same Redis, separate connections, and only one thing in common - `redis.url`, read
 * through `ConfigService` like every other connection in the app, so the queue cannot drift onto
 * a different server than the idempotency keys it will be asked to make safe. Passing `{ url }`
 * rather than parsing host/port/password by hand is part of that: BullMQ hands the string to
 * ioredis (`new IORedis(url, rest)` - verified in bullmq 6.3.10's `RedisConnection`), which is
 * the same code path `RedisService` takes, so `rediss://` and credentials behave identically in
 * both. What BullMQ adds on top is its own choice: given plain options rather than a client, it
 * sets `maxRetriesPerRequest: null` itself for the blocking connection, which is exactly why
 * plain options are what it is given here.
 *
 * ## Registered once
 *
 * `forRootAsync` is the shared configuration for every queue in the process (`forRoot` is
 * `global: true` in `@nestjs/bullmq`), so this is the one place a connection is described. Steps
 * 28 and 31 add queues to this app; they call `BullModule.registerQueue` and inherit this
 * connection rather than describing a second one.
 *
 * ## What is deliberately absent
 *
 * No `defaultJobOptions`. Attempts, backoff and retention are the retry policy, the retry policy
 * is what makes "the job ran twice" survivable on a money path, and Step 27's proposal is where
 * that gets decided. A default set here would be a decision made in passing, in the wrong file,
 * by whoever wired the queue.
 */
export function paymentsQueueRootOptions(config: ConfigService): BullRootModuleOptions {
  return {
    connection: { url: config.getOrThrow<string>('redis.url') },
  };
}

/**
 * `ConfigModule` is not imported below because it is global (`isGlobal: true` in `AppModule`),
 * so `ConfigService` is injectable here without it - the same arrangement `RedisService` relies
 * on.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: paymentsQueueRootOptions,
    }),
    BullModule.registerQueue({ name: PAYMENTS_QUEUE }),
  ],
  providers: [PaymentsQueueService, PaymentsProcessor],
  exports: [PaymentsQueueService],
})
export class PaymentsQueueModule {}
