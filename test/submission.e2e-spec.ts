import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import {
  DEFAULT_FALLBACK_HORIZON_URL,
  DEFAULT_FRIENDBOT_URL,
} from './../src/config/configuration.js';
import { UserStatus } from './../src/generated/prisma/enums.js';
import { type SessionUser } from './../src/identity/token/token.service.js';
import {
  type NotificationsService,
  type PaymentResultNotice,
} from './../src/notifications/notifications.service.js';
import { PAYMENTS_QUEUE } from './../src/payments/jobs/payments-queue.js';
import { PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS } from './../src/payments/jobs/payments-queue-connection.js';
import { PaymentsQueueService } from './../src/payments/jobs/payments-queue.service.js';
import { PaymentsConfirmationService } from './../src/payments/services/payments-confirmation.service.js';
import { PaymentsService } from './../src/payments/services/payments.service.js';
import { PaymentsSubmissionService } from './../src/payments/services/payments-submission.service.js';
import {
  claimForSubmission,
  recordEnvelope,
} from './../src/payments/services/transaction-status.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { KmsKeyWrapper, createKmsClient } from './../src/wallet/custody/kms-key-wrapper.js';
import { SeedCustodyService } from './../src/wallet/custody/seed-custody.service.js';
import { UsdcTrustlineService } from './../src/wallet/provisioning/usdc-trustline.js';
import {
  StellarAccountNotFoundError,
  type StellarBalanceLine,
} from './../src/wallet/stellar/account-source.js';
import {
  HorizonAccountSource,
  createHorizonServer,
} from './../src/wallet/stellar/horizon-account-source.js';
import {
  HorizonTransactionLookup,
  transactionCodeOf,
} from './../src/wallet/stellar/horizon-transaction-lookup.js';
import { HorizonTransactionSubmitter } from './../src/wallet/stellar/horizon-transaction-submitter.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Step 27 against the real things, in two halves that need different worlds.
 *
 * ## The bound on a wedged Redis (runs everywhere)
 *
 * The first half needs no Testnet and no KMS: it boots the real `AppModule`, writes a real payment
 * row the ordinary way, then **wedges Redis** (`CLIENT PAUSE`, which makes the server stop
 * answering every client) and asserts that the payment fails within
 * `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS` rather than hanging on the sender's row lock - and that the
 * producer's connection works again afterwards. That second assertion is the point of the test: the
 * failure has to be bounded and transient, not a poisoned client. It is here rather than in
 * `test/queue.e2e-spec.ts` because what it protects is the *money* path - the enqueue runs inside
 * `PaymentsService.create`'s transaction.
 *
 * The HTTP endpoint is deliberately not used. The idempotency interceptor's Redis is the same
 * wedged server, and a paused Redis *delays* the interceptor's commands rather than failing them -
 * so an HTTP request would wait out the pause and then succeed, proving nothing about the bound.
 * The call is made straight to `PaymentsService.create`, which is the code path whose duration the
 * bound exists to limit.
 *
 * ## The real submission (gated on `RUN_STELLAR_IT=1`)
 *
 * The second half is the Day 4 audit item: a real signed transaction submitted to Testnet by the
 * real service, with the row and *the network* both asked what happened; a job deliberately run a
 * second time producing no second transaction; and a sweep for the sender's seed across every log
 * line the run produced.
 *
 * One substitution is unavoidable and is stated rather than hidden: **the USDC issuer is this
 * test's own account.** Circle's Testnet USDC has no programmatic faucet, so a sender cannot be
 * given any. The test creates an issuer keypair, funds it, points `stellar.usdcIssuer` at it for
 * the run, and mints from it - all real Testnet transactions, with the app's own
 * `UsdcTrustlineService` establishing the trustlines. The asset code is unchanged (`USDC`) and the
 * code path that distinguishes assets is the one the configuration drives. Nothing else is
 * substituted: KMS is a real KMS endpoint, Horizon is real, the signatures are real, and the row
 * under test is in the configured database.
 *
 * ```bash
 * # a KMS endpoint that holds the key below (Moto on 5055 is what Step 18's audit used)
 * docker run -d --name cashping-kms -p 5055:5000 motoserver/moto:5.2.3
 * export AWS_REGION=eu-west-1
 * export AWS_KMS_KEY_ID=$(aws --endpoint-url http://localhost:5055 kms create-key \
 *   --description cashping-seeds --query KeyMetadata.Arn --output text)
 * export AWS_ENDPOINT_URL=http://localhost:5055
 * RUN_STELLAR_IT=1 npm run test:e2e test/submission.e2e-spec.ts
 * ```
 *
 * `DATABASE_URL`, `REDIS_URL`, `STELLAR_HORIZON_URL` and `STELLAR_USDC_ISSUER` come from `.env`;
 * the issuer is overridden inside the run, as above.
 */

const STELLAR = process.env['RUN_STELLAR_IT'] === '1';

/** How long the test stops Redis answering for. Comfortably longer than the bound under test. */
const REDIS_PAUSE_MS = 6000;

/** The bound, plus what a loaded machine may add before the rejection arrives. */
const BOUND_SLACK_MS = 2000;

/** Long enough for a probe round trip, short enough to fail inside vitest's own cap. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The app's config, read from this process's environment (as `provisioning.e2e-spec.ts` does), so
 * an integration run says what it is pointed at on the command line rather than inheriting it
 * silently from a file.
 */
function configWith(overrides: Record<string, string | number | undefined> = {}): ConfigService {
  const values: Record<string, string | number | undefined> = {
    nodeEnv: 'test',
    'database.url': process.env['DATABASE_URL'],
    'redis.url': process.env['REDIS_URL'],
    'aws.region': process.env['AWS_REGION'] ?? 'eu-west-1',
    'aws.endpointUrl': process.env['AWS_ENDPOINT_URL'],
    'aws.accessKeyId': process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    'aws.secretAccessKey': process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    'aws.kmsKeyId': process.env['AWS_KMS_KEY_ID'],
    'stellar.network': 'TESTNET',
    'stellar.horizonUrl':
      process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org',
    'stellar.fallbackHorizonUrl': DEFAULT_FALLBACK_HORIZON_URL,
    'stellar.friendbotUrl': process.env['STELLAR_FRIENDBOT_URL'] ?? DEFAULT_FRIENDBOT_URL,
    'stellar.usdcIssuer': process.env['STELLAR_USDC_ISSUER'],
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`missing ${key} - see this spec's header for what to export`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

/** A number this run has not registered, in the local spelling. */
function freshLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/** `+233241234567` from `0241234567`, without the normalizer's help. */
function toE164(localNumber: string): string {
  return `+233${localNumber.replace(/^0/, '')}`;
}

/** A session-shaped actor: what `PaymentsService.create` is handed, for a user row that exists. */
function actorFor(userId: string, phoneNumber: string, handle: string): SessionUser {
  return { id: userId, phoneNumber, status: UserStatus.ACTIVE, handle };
}

/**
 * Horizon, replaced by a map of balances (the same fake `test/payments.e2e-spec.ts` uses).
 *
 * The bound test only needs `readBalances` to answer with something spendable; everything below
 * this fake - the account row, the trustline decision, the lock, the insert, the enqueue - is the
 * real code.
 */
class FakeStellar {
  issuer = '';

  readonly balances = new Map<string, string>();

  async loadBalances(accountId: string): Promise<readonly StellarBalanceLine[]> {
    const balance = this.balances.get(accountId);

    if (balance === undefined) {
      throw new StellarAccountNotFoundError(accountId);
    }

    return [
      { asset_type: 'native', balance: '100.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: this.issuer,
        balance,
        limit: '922337203685.4775807',
        is_authorized: true,
      },
    ];
  }

  /** What `BalancesService` reports as the network a balance belongs to. */
  network(): string {
    return 'TESTNET';
  }
}

/** What a promise rejected with, as a status and a message (the payment path is not HTTP here). */
async function failureOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { getStatus?: () => number; message: string };

    return { status: failure.getStatus?.() ?? 0, message: failure.message };
  }

  throw new Error('expected the payment to be refused, and it was not');
}

/**
 * Waits for something a worker does asynchronously, and fails with a readable message if it never
 * happens.
 *
 * Polling rather than sleeping a fixed amount: the orphan job's arrival at the worker is a race
 * between the pause ending and this test's next line, and a fixed sleep would either be slow or
 * flaky. `condition` is re-read every 50ms until `timeoutMs` is up.
 */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

describe('the enqueue bound (Step 27)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let enqueuer: PaymentsQueueService;
  /** The app's *registered* queue, for the recovery probe's events. */
  let queueEvents: QueueEvents;
  /** A plain client on the same Redis, used to wedge it (the app's connections cannot do it). */
  let wedge: Redis;

  const userIds: string[] = [];
  const phoneNumbers: string[] = [];

  let sender: SessionUser;
  let recipient: SessionUser;

  beforeAll(async () => {
    const stellar = new FakeStellar();
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      // The only substitution: a balance read that needs no network. Everything else - the real
      // `PaymentsService`, the real `PaymentsQueueService`, the real producer connection, the real
      // worker, real Postgres and real Redis - is the application.
      .overrideProvider(StellarService)
      .useValue(stellar)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    enqueuer = app.get(PaymentsQueueService);

    const config = app.get(ConfigService);
    const redisUrl = config.getOrThrow<string>('redis.url');

    // The same issuer `UsdcTrustlineService` compares the fake lines against, read from the app's
    // own configuration so the two cannot disagree.
    stellar.issuer = config.getOrThrow<string>('stellar.usdcIssuer');

    wedge = new Redis(redisUrl);
    queueEvents = new QueueEvents(PAYMENTS_QUEUE, { connection: { url: redisUrl } });
    await queueEvents.waitUntilReady();

    const prefix = `sub${randomInt(1000, 10_000)}`;
    const numbers = { sender: freshLocalNumber(), recipient: freshLocalNumber() };

    phoneNumbers.push(toE164(numbers.sender), toE164(numbers.recipient));

    // The database outlives a run, so a number left behind by a run that died would make the first
    // insert of this one a 409 with nothing to do with this file.
    await prisma.transaction.deleteMany({
      where: {
        OR: [
          { sender: { phoneNumber: { in: phoneNumbers } } },
          { recipient: { phoneNumber: { in: phoneNumbers } } },
        ],
      },
    });
    await prisma.stellarAccount.deleteMany({
      where: { user: { phoneNumber: { in: phoneNumbers } } },
    });
    await prisma.user.deleteMany({ where: { phoneNumber: { in: phoneNumbers } } });

    const senderRow = await prisma.user.create({
      data: {
        phoneNumber: toE164(numbers.sender),
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        handle: `${prefix}s`,
      },
      select: { id: true },
    });
    const recipientRow = await prisma.user.create({
      data: {
        phoneNumber: toE164(numbers.recipient),
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        handle: `${prefix}r`,
      },
      select: { id: true },
    });

    userIds.push(senderRow.id, recipientRow.id);

    sender = actorFor(senderRow.id, toE164(numbers.sender), `${prefix}s`);
    recipient = actorFor(recipientRow.id, toE164(numbers.recipient), `${prefix}r`);

    const senderPublicKey = await giveWallet(senderRow.id, '10.0000000');

    // The recipient needs a wallet too: this test is about the enqueue, and the submission job that
    // a successful enqueue would queue is not run here - but a payment whose recipient has no
    // wallet is a different failure than the one under test.
    await giveWallet(recipientRow.id, '0.0000000');

    console.log(`[step 27] bound test: sender ${senderPublicKey}`);
  }, 60_000);

  /** A wallet row for a user, with a generated public key and a balance the fake reports. */
  async function giveWallet(userId: string, balance: string): Promise<string> {
    const publicKey = Keypair.random().publicKey();

    const stellar = app.get(StellarService) as unknown as FakeStellar;

    await prisma.stellarAccount.create({
      data: {
        userId,
        publicKey,
        encryptedSecretKey: 'cp-kms-1.test.test.test.test.test',
        dataKeyArn: 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-0000-0000-000000000000',
      },
      select: { id: true },
    });

    stellar.balances.set(publicKey, balance);

    return publicKey;
  }

  afterAll(async () => {
    /**
     * Transactions first: both relations are `ON DELETE RESTRICT` deliberately, so a test that
     * created some deals with them before the users can go. A wedged-Redis run leaves no rows (the
     * point of the test), but a *successful* create would - and this run may have made one.
     */
    await prisma.transaction.deleteMany({
      where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }] },
    });
    await prisma.stellarAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await queueEvents.close();
    await app.close();
    await wedge.quit();
  }, 60_000);

  it('fails the payment inside the bound when Redis stops answering, and the producer recovers', async () => {
    const key = randomUUID();

    /**
     * The wedge. `CLIENT PAUSE` makes this server stop answering *every* client, including the ones
     * BullMQ opened, for `REDIS_PAUSE_MS` - which is the closest thing to "Redis is up but not
     * answering" that a test can manufacture. The call itself is awaited at the end: with the `ALL`
     * modifier the issuer's own reply arrives when the pause ends.
     */
    const pause = wedge.call('CLIENT', 'PAUSE', String(REDIS_PAUSE_MS), 'ALL');

    /**
     * The worker's own error lines, captured because the run produces one that is worth asserting:
     * the job Redis eventually ran is for a payment that does not exist (see below).
     */
    const capturedErrors: string[] = [];
    const logging = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown): void => {
        capturedErrors.push(String(message));
      });

    // Let the pause take effect: a command sent before it lands is served normally, and then the
    // test would be measuring nothing.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const started = Date.now();
    const failure = await failureOf(
      payments.create(sender, { recipientId: recipient.id, amount: '1' }, key),
    );
    const elapsed = Date.now() - started;

    // The failure is ioredis's own: the enqueue command was abandoned, not the process, and not the
    // transaction.
    expect(failure.message).toMatch(/Command timed out/);

    // Inside the bound (plus slack for a loaded machine), and *before* the pause ended - which is
    // what makes this the bound's doing rather than the pause's.
    expect(elapsed).toBeGreaterThanOrEqual(PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS - 250);
    expect(elapsed).toBeLessThan(PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS + BOUND_SLACK_MS);
    expect(elapsed).toBeLessThan(REDIS_PAUSE_MS);

    // And the payment did not happen: the transaction rolled back with the rejection, so the row
    // the lock was held for is not in the table.
    expect(
      await prisma.transaction.count({ where: { senderId: sender.id, idempotencyKey: key } }),
    ).toBe(0);

    await pause;
    await new Promise((resolve) => setTimeout(resolve, 300));

    /**
     * The orphan job, which is the accepted cost of enqueueing inside the transaction (Step 27's
     * proposal, §6) - asserted here rather than left as noise, because the whole argument for that
     * ordering is that this failure is *loud*. Redis runs the abandoned Lua script the moment the
     * pause ends, so a job appears for a payment id that was rolled back, and the handler refuses
     * it: "does not exist, so there is nothing to submit". Silently acknowledging it is the failure
     * mode this ordering was chosen to avoid.
     */
    await waitFor(
      () =>
        capturedErrors.some((line) =>
          line.includes('does not exist, so there is nothing to submit'),
        ),
      10_000,
      "the worker to reject the orphan job for the rolled-back payment",
    );

    // The connection survived: a probe round-trips through the same producer, on the same Redis. A
    // bound that poisoned the client would be a bigger availability problem than the one it fixes,
    // which is why this is asserted rather than assumed.
    const probe = await enqueuer.enqueueProbe();

    await expect(probe.waitUntilFinished(queueEvents, PROBE_TIMEOUT_MS)).resolves.toMatchObject({
      pong: true,
    });

    logging.mockRestore();

    console.log(
      `[step 27] wedged Redis: payment failed after ${elapsed}ms (bound ${PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS}ms), no row written, orphan job rejected loudly, producer recovered`,
    );
  }, 30_000);
});

/** Horizon's answer for an account, fetched without going through any of the app. */
async function horizonAccount(publicKey: string): Promise<{
  sequence: string;
  balances: ReadonlyArray<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
}> {
  const response = await fetch(`${horizonUrl()}/accounts/${publicKey}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Horizon answered HTTP ${response.status} for ${publicKey}`);
  }

  return (await response.json()) as never;
}

/**
 * Horizon's record of one transaction, or `null` when it has none.
 *
 * `null` says Horizon's history does not hold this hash. It is *not* the mark of a refused
 * submission: a transaction the network refuses is still closed by a ledger as unsuccessful and
 * does leave a record behind - see `horizonFailedTransaction` - so every caller below pairs the
 * answer with something else that says what it means.
 */
async function horizonTransaction(
  hash: string,
): Promise<{ successful: boolean; ledger: number } | null> {
  const response = await fetch(`${horizonUrl()}/transactions/${hash}`, {
    headers: { accept: 'application/json' },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Horizon answered HTTP ${response.status} for transaction ${hash}`);
  }

  return (await response.json()) as never;
}

/**
 * `horizonTransaction`, given the seconds Horizon's history can lag its ledgers by.
 *
 * A transaction that fails on-ledger reaches a closed ledger *before* Horizon answers its
 * submission - `tx_failed` is a ledger's answer, and it is why the fee is charged - but the record
 * is written by Horizon's ingester rather than by the ledger, so a fetch a moment later can still
 * answer 404. Only the index is late; the assertion this feeds stays exact.
 */
async function horizonTransactionEventually(
  hash: string,
  timeoutMs = 15_000,
): Promise<{ successful: boolean; ledger: number } | null> {
  const deadline = Date.now() + timeoutMs;

  let record = await horizonTransaction(hash);

  while (record === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    record = await horizonTransaction(hash);
  }

  return record;
}

/**
 * A hash Horizon has recorded as landed-and-refused, preferring the common `tx_failed`.
 *
 * The FAILED branch of the poll needs a row that is `PROCESSING` and holding the hash of a
 * transaction a ledger closed as unsuccessful, and the app's own submission path never leaves one.
 * A transaction whose operation fails *is* closed by a ledger - that is what `tx_failed` is - and
 * Horizon answers the submission that produced it with an HTTP 400 carrying the operation code,
 * which Step 27's triage acts on as a verdict: the row goes straight to `FAILED` and no poll is
 * ever owed for it. The third test below drives exactly that payment, and reads its hash back from
 * Horizon, which is where this was learned.
 *
 * So the test arranges the two halves of the row by hand, and only one of them is a question of
 * fact: the *hash* must name a real ledger entry, which is why it is read out of Testnet's own
 * history, while the *row* around it is written the way a submission writes one. That is also the
 * honest shape of the poll's contract - "resolve the network's verdict on a hash" - and a hash the
 * network has already answered for is that verdict with no timing left to arrange.
 */
async function horizonFailedTransaction(): Promise<{
  hash: string;
  sequence: string;
  code: string;
} | null> {
  const response = await fetch(
    `${horizonUrl()}/transactions?include_failed=true&order=desc&limit=200`,
    { headers: { accept: 'application/json' } },
  );

  if (!response.ok) {
    throw new Error(`Horizon answered HTTP ${response.status} for failed transactions`);
  }

  const page = (await response.json()) as {
    _embedded?: {
      records?: ReadonlyArray<{
        hash: string;
        successful: boolean;
        result_xdr: string;
        source_account_sequence?: string;
      }>;
    };
  };

  const decodable = (page._embedded?.records ?? []).filter(
    (record) => record.successful === false && transactionCodeOf(record.result_xdr) !== null,
  );
  const wanted =
    decodable.find((record) => transactionCodeOf(record.result_xdr) === 'tx_failed') ??
    decodable[0];

  if (wanted === undefined) {
    return null;
  }

  return {
    hash: wanted.hash,
    sequence: wanted.source_account_sequence ?? '0',
    code: transactionCodeOf(wanted.result_xdr) as string,
  };
}
function usdcLineOf(
  account: { balances: ReadonlyArray<{ asset_code?: string; asset_issuer?: string; balance: string }> },
  issuer: string,
): string | undefined {
  return account.balances.find(
    (line) => line.asset_code === 'USDC' && line.asset_issuer === issuer,
  )?.balance;
}

function horizonUrl(): string {
  return process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org';
}

/** Friendbot pays a Testnet account its starting balance; 10,000 Testnet XLM is not money. */
async function fund(publicKey: string): Promise<void> {
  const response = await fetch(`${horizonUrl()}/friendbot?addr=${publicKey}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `friendbot answered HTTP ${response.status} for ${publicKey}: ${await response.text()}`,
    );
  }
}

/**
 * Everything a run's log lines said, and every payload it produced, in one place for the sweep.
 *
 * The capture is installed before the first submission and read after the last one, because the
 * claim Step 27 is audited on is about the whole run: a seed that appears in a single debug line
 * six calls deep is exactly what a sweep of one method's output would miss.
 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (message: unknown, ...rest: unknown[]): void => {
    lines.push([message, ...rest].map((part) => String(part)).join(' '));
  };

  const spies = [
    vi.spyOn(Logger.prototype, 'log').mockImplementation(record),
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(record),
    vi.spyOn(Logger.prototype, 'error').mockImplementation(record),
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(record),
  ];

  return {
    lines,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

describe.skipIf(!STELLAR)('the submission job, against Testnet (Step 27)', () => {
  /** What this run wrote, so it can be deleted: the Testnet accounts themselves stay on the ledger. */
  const userIds: string[] = [];
  const phoneNumbers: string[] = [];

  let prisma: PrismaService;
  let custody: SeedCustodyService;
  let submission: PaymentsSubmissionService;
  /** The run's Horizon door: the same service `UsdcTrustlineService` submits its trustlines through. */
  let stellar: StellarService;
  /** The run's config, with `stellar.usdcIssuer` pointed at the issuer this run mints from. */
  let config: ConfigService;

  /** The issuer this run created and funded; every trustline and every USDC payment uses it. */
  let issuerPublicKey = '';

  /** The sender: the account whose key signs, and the wallet the money leaves. */
  let senderPublicKey = '';
  let senderUserId = '';
  let recipientPublicKey = '';

  /** The payment row this run submits, created directly - the creation path is Step 25's. */
  let paymentId = '';

  /** The second row the Step 28 FAILED case drives through the poll, cleaned up with the first. */
  let failedPaymentId = '';

  /** The third row: a payment the network refuses outright, so the poll never has a hash to look up. */
  let refusedPaymentId = '';

  /** The recipient's user id, kept because the failed-case row needs a real recipient relation. */
  let recipientUserId = '';

  /** The trustline service, so the failed-case transaction pays the same asset the mint did. */
  let usdc: UsdcTrustlineService;

  const logs = captureLogs();

  /** The assertion the audit asks for, in one place: this text must not contain the seed. */
  function sweepFor(label: string, text: string, seed: string): void {
    expect(text.includes(seed), `${label} contains the account's secret seed`).toBe(false);
  }

  beforeAll(async () => {
    // The issuer this run mints from, because Circle's Testnet USDC has no programmatic faucet.
    const issuer = Keypair.random();

    issuerPublicKey = issuer.publicKey();
    await fund(issuerPublicKey);

    config = configWith({ 'stellar.usdcIssuer': issuerPublicKey });

    prisma = new PrismaService(config);

    stellar = new StellarService(
      config,
      new HorizonAccountSource(config, createHorizonServer),
      new HorizonTransactionSubmitter(config, createHorizonServer),
      // Step 28's third port, wired here as `WalletModule` wires it. This run never polls - the
      // sweep is a separate suite's subject and `PaymentsConfirmationService` is not constructed
      // below - but the service under test takes it, and passing a fake would make this file's
      // `StellarService` a different object from the one the app builds.
      new HorizonTransactionLookup(config, createHorizonServer),
    );

    custody = new SeedCustodyService(new KmsKeyWrapper(config, createKmsClient), stellar);

    usdc = new UsdcTrustlineService(stellar, custody, config);
    const asset = usdc.asset();

    submission = new PaymentsSubmissionService(prisma, custody, stellar, usdc);

    const prefix = `sub${randomInt(1000, 10_000)}`;
    const numbers = { sender: freshLocalNumber(), recipient: freshLocalNumber() };

    phoneNumbers.push(toE164(numbers.sender), toE164(numbers.recipient));

    // The database outlives a run: a number left behind by one that died would make this run's
    // inserts 409s with nothing to do with this file.
    await prisma.transaction.deleteMany({
      where: {
        OR: [
          { sender: { phoneNumber: { in: phoneNumbers } } },
          { recipient: { phoneNumber: { in: phoneNumbers } } },
        ],
      },
    });
    await prisma.stellarAccount.deleteMany({
      where: { user: { phoneNumber: { in: phoneNumbers } } },
    });
    await prisma.user.deleteMany({ where: { phoneNumber: { in: phoneNumbers } } });

    const senderUser = await prisma.user.create({
      data: {
        phoneNumber: toE164(numbers.sender),
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        handle: `${prefix}s`,
      },
      select: { id: true },
    });
    const recipientUser = await prisma.user.create({
      data: {
        phoneNumber: toE164(numbers.recipient),
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        handle: `${prefix}r`,
      },
      select: { id: true },
    });

    senderUserId = senderUser.id;
    userIds.push(senderUser.id, recipientUser.id);
    recipientUserId = recipientUser.id;

    // Two real wallets, sealed by the real KMS, funded by the real friendbot, trusting the real
    // asset - the same three steps provisioning performs, in the same order.
    senderPublicKey = await createWallet(senderUser.id);
    recipientPublicKey = await createWallet(recipientUser.id);

    // The mint: the issuer pays USDC into the sender's wallet, which is how an asset comes to exist
    // on Testnet. The issuer holds its own credit, so it needs no trustline of its own.
    await stellar.withAccount(issuer.publicKey(), async (session) => {
      const transaction = session.build([
        Operation.payment({
          destination: senderPublicKey,
          asset,
          amount: '100.0000000',
        }),
      ]);

      transaction.sign(issuer);

      return stellar.submitTransaction(transaction);
    });

    // The row is created the way the API creates one - `PENDING` from the column's own default -
    // and the submission that follows is the state machine's (Step 29 keeps status writes in
    // `transaction-status.ts`, so this file never names the column).
    const row = await prisma.transaction.create({
      data: {
        senderId: senderUserId,
        recipientId: recipientUser.id,
        amount: '1.2500000',
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });

    paymentId = row.id;

    console.log(`[step 27] testnet run: issuer=${issuerPublicKey} sender=${senderPublicKey}`);
  }, 300_000);

  /** A sealed, funded, USDC-trusting Testnet wallet for a user - provisioning's three steps. */
  async function createWallet(userId: string): Promise<string> {
    const sealed = await custody.createSealedAccount();

    const row = await prisma.stellarAccount.create({
      data: {
        id: sealed.accountId,
        userId,
        publicKey: sealed.publicKey,
        encryptedSecretKey: sealed.encryptedSecretKey,
        dataKeyArn: sealed.dataKeyArn,
      },
      select: { id: true, publicKey: true, encryptedSecretKey: true, dataKeyArn: true },
    });

    await fund(sealed.publicKey);

    await new UsdcTrustlineService(stellar, custody, config).ensureFor(row);

    return sealed.publicKey;
  }

  afterAll(async () => {
    logs.restore();

    // The rows this run wrote, in the honest order - transactions first (both relations are
    // `ON DELETE RESTRICT`), then the wallets, then the users. The two Testnet accounts stay on the
    // ledger, funded and trusting this run's issuer, with a seed nobody holds: that is the one cost
    // of a real-network test, and it is Testnet-only.
    // Guarded: a run that failed before the payment row was written must not turn its cleanup into
    // a second failure (`id: undefined` is not a UUID).
    const written = [paymentId, failedPaymentId, refusedPaymentId].filter((id) => id !== '');

    if (written.length > 0) {
      await prisma.transaction.deleteMany({ where: { id: { in: written } } });
    }
    await prisma.stellarAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await prisma.$disconnect();
  }, 120_000);

  it('submits a real transaction, records it, and the network agrees it landed', async () => {
    const before = {
      sender: await horizonAccount(senderPublicKey),
      recipient: await horizonAccount(recipientPublicKey),
    };

    const outcome = await submission.submit(paymentId);

    expect(outcome.status).toBe('accepted');
    expect(outcome.stellarTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.ledger).toBeGreaterThan(0);

    // The row, as the record this step is responsible for.
    const row = await prisma.transaction.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        status: true,
        stellarTxHash: true,
        stellarTxSequence: true,
        submissionDeadline: true,
        failureReason: true,
      },
    });

    expect(row.status).toBe('PROCESSING');
    expect(row.stellarTxHash).toBe(outcome.stellarTxHash);
    expect(row.failureReason).toBeNull();
    // A sequence number that is a real number, as text - and a deadline in the future, because the
    // transaction it names was accepted a moment ago.
    expect(row.stellarTxSequence).toMatch(/^[0-9]+$/);
    expect(row.submissionDeadline?.getTime()).toBeGreaterThan(Date.now());

    // And the network, asked directly - not through this codebase, and not through the service
    // whose work is being checked.
    const transaction = await horizonTransaction(outcome.stellarTxHash as string);

    expect(transaction).not.toBeNull();
    expect(transaction?.successful).toBe(true);

    const after = {
      sender: await horizonAccount(senderPublicKey),
      recipient: await horizonAccount(recipientPublicKey),
    };

    // 1.25 USDC moved, exactly, in the asset this run configured.
    expect(usdcLineOf(after.sender, issuerPublicKey)).toBe('98.7500000');
    expect(usdcLineOf(after.recipient, issuerPublicKey)).toBe('1.2500000');
    expect(usdcLineOf(before.recipient, issuerPublicKey)).toBe('0.0000000');
    // The transaction consumed one sequence number on the sender's account.
    expect(BigInt(after.sender.sequence) - BigInt(before.sender.sequence)).toBe(1n);

    console.log(
      `[step 27] submitted payment=${paymentId} hash=${outcome.stellarTxHash} ledger=${outcome.ledger} sequence=${row.stellarTxSequence} sender_usdc=${usdcLineOf(after.sender, issuerPublicKey)} recipient_usdc=${usdcLineOf(after.recipient, issuerPublicKey)}`,
    );
  }, 120_000);

  it('produces no second transaction when the job is deliberately run again', async () => {
    const before = await horizonAccount(senderPublicKey);
    const rowBefore = await prisma.transaction.findUniqueOrThrow({
      where: { id: paymentId },
      select: { stellarTxHash: true },
    });

    // The same call the worker would make on a stalled-job retry, a redeploy, or an operator
    // re-running the job: the row is already `PROCESSING` with a recorded transaction inside its
    // deadline, so this attempt must do nothing at all.
    const second = await submission.submit(paymentId);

    expect(second.status).toBe('deferred');
    expect(second.detail).toBe('recorded-transaction-still-valid');

    // Asserted against the network rather than against the code: the sender's sequence did not
    // move, so no second transaction consumed one.
    const after = await horizonAccount(senderPublicKey);

    expect(after.sequence).toBe(before.sequence);

    // And the recorded transaction is the same one, still the only hash this payment names.
    const rowAfter = await prisma.transaction.findUniqueOrThrow({
      where: { id: paymentId },
      select: { stellarTxHash: true, status: true },
    });

    expect(rowAfter.stellarTxHash).toBe(rowBefore.stellarTxHash);
    expect(rowAfter.status).toBe('PROCESSING');

    console.log(
      `[step 27] re-ran the job: outcome=${second.status} (${second.detail}) hash=${rowAfter.stellarTxHash} sequence=${after.sequence} (unchanged)`,
    );
  }, 60_000);

  it("never lets the account's secret seed reach a log line, a row or a payload", async () => {
    const wallet = await prisma.stellarAccount.findUniqueOrThrow({
      where: { userId: senderUserId },
      select: { id: true, publicKey: true, encryptedSecretKey: true, dataKeyArn: true },
    });

    // The seed exists in this process for the length of this call, exactly as it does during a
    // submission - which is what makes searching for it mean something rather than being a
    // formality. It is opened here, and then out of scope, the same way the service opens it.
    const keypair = await custody.openSeed(wallet);
    const seed = keypair.secret();

    // A Stellar secret seed, and *not* the public key: a sweep for the wrong string would pass
    // while proving nothing.
    expect(seed).toMatch(/^S[A-Z0-9]{55}$/);
    expect(seed).not.toBe(senderPublicKey);

    // What the stored row holds is the sealed envelope, never the seed.
    expect(wallet.encryptedSecretKey.startsWith('cp-kms-1.')).toBe(true);

    const outcome = await submission.submit(paymentId);

    sweepFor("the run's log lines", logs.lines.join('\n'), seed);
    sweepFor('the stored wallet row', JSON.stringify(wallet), seed);
    sweepFor(
      'the payment row',
      JSON.stringify(await prisma.transaction.findUniqueOrThrow({ where: { id: paymentId } })),
      seed,
    );
    // The job's result, which is what BullMQ would store and an operator would read back.
    sweepFor('the submission result', JSON.stringify(outcome), seed);

    // The sweep has to be over something: a run that logged nothing would pass this test for the
    // wrong reason.
    expect(logs.lines.length).toBeGreaterThan(0);

    console.log(
      `[step 27] key-material sweep: ${logs.lines.length} log lines, 1 wallet row, 1 payment row and 1 result searched - seed absent`,
    );
  }, 60_000);

  it('Step 28: the sweep resolves the submitted payment to SUCCESSFUL against the real ledger', async () => {
    const before = await prisma.transaction.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true, stellarTxHash: true, failureReason: true },
    });

    expect(before.status).toBe('PROCESSING');
    expect(before.stellarTxHash).toMatch(/^[0-9a-f]{64}$/);

    // The real confirmation service, with only the SMS provider substituted (this run is about the
    // poll, not the message). Horizon is real, the row is real, and the writers are the app's.
    const notices: PaymentResultNotice[] = [];
    const confirmations = new PaymentsConfirmationService(
      prisma,
      stellar,
      {
        sendPaymentResult: async (
          _phoneNumber: string,
          notice: PaymentResultNotice,
        ): Promise<void> => {
          notices.push(notice);
        },
      } as unknown as NotificationsService,
    );

    const result = await confirmations.sweep();

    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true, failureReason: true, stellarTxHash: true },
    });

    expect(after.status).toBe('SUCCESSFUL');
    expect(after.failureReason).toBeNull();

    // The ledger outcome, asked independently of the row and of the poll: the hash the sweep looked
    // up is the hash the network holds, and the network said "successful".
    const onLedger = await horizonTransaction(after.stellarTxHash as string);
    expect(onLedger?.successful).toBe(true);

    expect(result.confirmed).toBeGreaterThanOrEqual(1);

    // The sender was told, from the row.
    expect(notices.some((notice) => notice.status === 'SUCCESSFUL')).toBe(true);

    console.log(
      `[step 28] sweep: payment=${paymentId} hash=${after.stellarTxHash} PROCESSING -> SUCCESSFUL (polled=${result.polled} confirmed=${result.confirmed})`,
    );
  }, 120_000);

  it('Step 28: a transaction that lands but fails on-ledger resolves to FAILED with a readable reason', async () => {
    // A second payment row, over the existing sender and recipient, as the vehicle for a poll. It
    // starts PENDING (the column default) and is moved only through the writers - the same path the
    // submission job uses, which is the only path Step 29 leaves to a status write.
    const failedRow = await prisma.transaction.create({
      data: {
        senderId: senderUserId,
        recipientId: recipientUserId,
        amount: '60.0000000',
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });

    failedPaymentId = failedRow.id;

    // A transaction the ledger has refused, read from the network's own history - see
    // `horizonFailedTransaction` for why it is read rather than submitted.
    const failed = await horizonFailedTransaction();

    expect(failed, 'Testnet had no landed-but-failed transaction to read').not.toBeNull();

    const onLedger = failed as { hash: string; sequence: string; code: string };

    // The same question the sweep will ask, asked first: Horizon has it, and the ledger refused it.
    const landed = await horizonTransaction(onLedger.hash);

    expect(landed).not.toBeNull();
    expect(landed?.successful).toBe(false);

    // Move the row exactly the way a submission does: claim, then record the envelope.
    expect(await claimForSubmission(prisma, failedPaymentId)).toBe(true);
    expect(
      await recordEnvelope(prisma, failedPaymentId, null, {
        hash: onLedger.hash,
        sequence: onLedger.sequence,
        // The deadline the row would have recorded had this app submitted it. The poll does not read
        // it for a transaction the ledger already has, but a row with a hash and no deadline is a
        // shape `recordEnvelope` never writes.
        deadline: new Date(Date.now() + 180_000),
      }),
    ).toBe(true);

    const before = await prisma.transaction.findUniqueOrThrow({
      where: { id: failedPaymentId },
      select: { status: true },
    });

    expect(before.status).toBe('PROCESSING');

    const notices: PaymentResultNotice[] = [];
    const confirmations = new PaymentsConfirmationService(
      prisma,
      stellar,
      {
        sendPaymentResult: async (
          _phoneNumber: string,
          notice: PaymentResultNotice,
        ): Promise<void> => {
          notices.push(notice);
        },
      } as unknown as NotificationsService,
    );

    const result = await confirmations.sweep();

    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: failedPaymentId },
      select: { status: true, failureReason: true },
    });

    expect(after.status).toBe('FAILED');

    // The readable reason: the transaction-level code the decoded result XDR names, in the same
    // vocabulary - and under the same prefix - the submit path writes for the same code, because
    // both describe a transaction a ledger closed (`landedPrefixFor` in `submission-triage.ts`).
    // A fetched Horizon record has no `result_codes` field, so the code is decoded from
    // `result_xdr` - `tx_failed` for the usual op-level refusal, and whatever real `tx_*` code the
    // record carries.
    expect(after.failureReason).toBe(`landed-unsuccessful:${onLedger.code}`);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(notices.some((notice) => notice.status === 'FAILED')).toBe(true);

    console.log(
      `[step 28] FAILED case: payment=${failedPaymentId} hash=${onLedger.hash} PROCESSING -> FAILED (${after.failureReason})`,
    );
  }, 120_000);

  it('Step 28: a deliberately-invalid payment is refused at submission, and the row still records a landed failure', async () => {
    // The audit item's other half: a payment the network refuses, rather than one the poll
    // discovers. The sender holds ~98 USDC, so 1,000,000 USDC cannot be paid - Horizon answers the
    // submission with an HTTP 400 naming `op_underfunded` - and a permanent operation code is a
    // verdict in Step 27's triage: the row is `FAILED` immediately, never `PROCESSING`, so there is
    // no poll to owe for it.
    //
    // A refusal is not the same as the envelope disappearing, though, and that is what this test is
    // careful about: the ledger still closes the transaction, as unsuccessful and with its fee
    // charged, so the hash the row keeps resolves on Horizon. The assertions below read that back
    // instead of assuming what a rejected submission leaves behind - and it is why the reason below
    // wears the *landed* prefix, the one the second case's poll writes as well: the two paths differ
    // in when the app learned the outcome, and in nothing else.
    const refusedRow = await prisma.transaction.create({
      data: {
        senderId: senderUserId,
        recipientId: recipientUserId,
        amount: '1000000.0000000',
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });

    refusedPaymentId = refusedRow.id;

    const balanceBefore = usdcLineOf(await horizonAccount(senderPublicKey), issuerPublicKey);

    // The app's own submission path: the same claim, build, sign and submit the job runs.
    const outcome = await submission.submit(refusedPaymentId);

    expect(outcome.status).toBe('failed');

    // The *outcome* carries no hash: the attempt ended in a refusal, and a refused submission is
    // not a landed one, so there is nothing for the outcome to report. What the row holds is a
    // different question - `markFailed` deliberately keeps the hash of the envelope that was built
    // as the fingerprint of the attempt - and the two statements are not in conflict.
    expect(outcome.stellarTxHash).toBeNull();

    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: refusedPaymentId },
      select: { status: true, failureReason: true, stellarTxHash: true },
    });

    // FAILED, with the operation code the network itself named - a verdict rather than an attempt,
    // because `op_underfunded` is a permanent code. Not `PROCESSING`, and not waiting on a poll:
    // the network has already answered, so there is nothing left for one to find out. The prefix is
    // `landed-unsuccessful:` rather than `submission-rejected:` - the correction Step 28's audit of
    // the vocabulary made: the transaction *is* in a ledger, closed unsuccessfully, and the network
    // charged the fee for it. Which caller learned that first is not what the prefix records.
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toBe('landed-unsuccessful:op_underfunded');

    // The row keeps the hash of the envelope this app built - `markFailed` keeps it on purpose, as
    // the fingerprint of the attempt - and this case is what says what such a hash *is*, which is
    // not what the first version of this test assumed: Horizon has a record under it. The network
    // evaluated the operations, refused them in a ledger and charged the fee, so the transaction
    // landed unsuccessfully even though what Horizon answered the *submission* with was a refusal.
    // The reason's prefix is what says so; the hash alone never would.
    const recordedHash = after.stellarTxHash ?? '';

    expect(recordedHash).toMatch(/^[0-9a-f]{64}$/);

    const refusedOnLedger = await horizonTransactionEventually(recordedHash);

    expect(refusedOnLedger, `Horizon has no record of ${recordedHash}`).not.toBeNull();
    expect(refusedOnLedger?.successful).toBe(false);

    // The money provably did not move, in both halves of that claim: the transaction under the hash
    // was closed as unsuccessful, and the sender's USDC line is unchanged. (The fee is XLM, charged
    // by the network rather than moved by the payment.)
    expect(usdcLineOf(await horizonAccount(senderPublicKey), issuerPublicKey)).toBe(balanceBefore);

    // And the row is terminal: a second attempt through a fresh load is `skipped` rather than a
    // second debit, which is the state machine's answer and not an error. The hash it reports is the
    // recorded one, unchanged - a skip builds nothing.
    const again = await submission.submit(refusedPaymentId);

    expect(again.status).toBe('skipped');
    expect(again.detail).toBe('status:FAILED');
    expect(again.stellarTxHash).toBe(recordedHash);

    console.log(
      `[step 28] deliberately-invalid case: payment=${refusedPaymentId} PENDING -> FAILED (${after.failureReason}) hash=${recordedHash} closed unsuccessful in ledger ${refusedOnLedger?.ledger}, sender USDC unchanged at ${balanceBefore}, second attempt skipped`,
    );
  }, 120_000);
});
