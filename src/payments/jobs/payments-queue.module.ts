import { BullModule, type BullRootModuleOptions } from '@nestjs/bullmq';
import { Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { WalletModule } from '../../wallet/wallet.module.js';
import { PaymentsConfirmationService } from '../services/payments-confirmation.service.js';
import { PaymentsSubmissionService } from '../services/payments-submission.service.js';
import { PaymentsProcessor } from './payments.processor.js';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_PRODUCER,
  type PaymentsQueueJobData,
  type PaymentsQueueJobName,
  type PaymentsQueueJobResult,
} from './payments-queue.js';
import { paymentsQueueProducerConnection } from './payments-queue-connection.js';
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
 * by whoever wired the queue - so the submission job carries its own options, in
 * `PaymentsQueueService`, where the job it belongs to is added.
 *
 * ## What Step 27 added, and why the connection story is now two connections
 *
 * Three things: the submission handler on the processor below, `PaymentsSubmissionService` as a
 * provider, and a *second* connection - the producer's (`PaymentsQueueProducer`). That last one is
 * the one worth explaining, because "the same Redis, separate connections" was a claim this file
 * made once and it is now made carefully:
 *
 * - The connection above (`paymentsQueueRootOptions`) is BullMQ's shared one, and it is what the
 *   **worker** runs on. It is left exactly as it was, with no `commandTimeout`, because a worker's
 *   reads are blocking (`BZPOPMIN` for seconds at a time) and ioredis arms a command timeout for
 *   blocking commands too - see `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS` for the full argument, and
 *   `payments-queue.module.spec.ts` for the assertion that this connection still carries a URL and
 *   nothing else.
 * - The producer's connection adds exactly one option: a three-second `commandTimeout`, because
 *   the enqueue runs inside `PaymentsService.create`'s row lock and an unbounded hang there is an
 *   availability cascade onto every payment from that sender (Step 27's proposal, §7).
 *
 * `@nestjs/bullmq` cannot express that split: `registerQueue` and the `@Processor` decorator both
 * exclude `connection` from their options, so every queue and worker shares the root connection.
 * The producer is therefore constructed here as a provider of its own, closed on shutdown, and the
 * registered queue stays registered - the readiness path and the worker's registration both still
 * go through it.
 *
 * ## Why `PaymentsSubmissionService` is provided here
 *
 * The dependency arrow between the two payments modules points one way - `PaymentsModule` imports
 * this one - so a submission service provided in `PaymentsModule` could not be injected into the
 * processor below without turning that arrow around. It is a *payment* service that happens to be
 * called by a job, which is why it lives in `src/payments/services/` rather than in this
 * directory; what is here is the wiring, which is the only thing this module knows how to do.
 */
export function paymentsQueueRootOptions(config: ConfigService): BullRootModuleOptions {
  return {
    connection: { url: config.getOrThrow<string>('redis.url') },
  };
}

/**
 * The app's producer-side handle on the payments queue: a `Queue` on its own connection, closed
 * when the application shuts down.
 *
 * A class rather than a bare `Queue` provider because of that last part. BullMQ connections are
 * live sockets and timers: a `Queue` created with `new` and never closed leaves the event loop
 * busy, which in a test suite is a process that hangs after its last assertion and in production is
 * a connection that outlives the thing that made it. `@nestjs/bullmq` closes the queues it
 * registers; this one is closed here, in the same file that created it, through the lifecycle hook
 * Nest calls on `app.close()`.
 *
 * `queue` is exposed rather than wrapped in an ADD-only API because the alternatives are both
 * worse: re-declaring the payload options here would split "what a job carries" from "when it is
 * added" across two files, and the class that would own that decision already exists one file up
 * (`PaymentsQueueService`). What this class owns is the connection, and that is what it keeps.
 */
@Injectable()
export class PaymentsQueueProducer implements OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsQueueProducer.name);

  readonly queue: Queue<PaymentsQueueJobData, PaymentsQueueJobResult, PaymentsQueueJobName>;

  constructor(config: ConfigService) {
    this.queue = new Queue<PaymentsQueueJobData, PaymentsQueueJobResult, PaymentsQueueJobName>(
      PAYMENTS_QUEUE,
      { connection: paymentsQueueProducerConnection(config) },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();

    this.logger.log(`The ${PAYMENTS_QUEUE} producer connection is closed`);
  }
}

/**
 * `ConfigModule` is not imported below because it is global (`isGlobal: true` in `AppModule`),
 * so `ConfigService` is injectable here without it - the same arrangement `RedisService` relies
 * on. `WalletModule` is imported for the three things a submission needs and nothing else: the
 * per-account sequence lock and the Horizon port (`StellarService`), the sealed seed
 * (`SeedCustodyService`), and the one definition of which asset a payment moves
 * (`UsdcTrustlineService`). `PrismaModule` is where the row the job is about lives.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: paymentsQueueRootOptions,
    }),
    BullModule.registerQueue({ name: PAYMENTS_QUEUE }),
    PrismaModule,
    WalletModule,
    /**
     * Step 28: the confirmation sweep tells the sender what happened, and `NotificationsService`
     * is the app's only door to that (it owns the SMS template and the `SMS_SENDER` seam). The
     * module is imported rather than the provider configured again, because two bindings for one
     * sender would be two answers to "which provider".
     */
    NotificationsModule,
  ],
  providers: [
    PaymentsQueueService,
    PaymentsQueueProducer,
    // Both names, one instance: the class is what Nest constructs and closes, the token is what
    // the enqueue service asks for (see `PaymentsQueueHandle` for why it does not ask for the
    // class).
    { provide: PAYMENTS_QUEUE_PRODUCER, useExisting: PaymentsQueueProducer },
    PaymentsProcessor,
    PaymentsSubmissionService,
    /**
     * Step 28's sweep. Provided here rather than in `PaymentsModule` for exactly the reason the
     * submission service is (see `PaymentsQueueModule`'s docblock): the arrow only ever points
     * this way, and the processor below is its consumer.
     */
    PaymentsConfirmationService,
  ],
  exports: [PaymentsQueueService],
})
export class PaymentsQueueModule {}
