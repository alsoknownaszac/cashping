import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { Amount } from './../src/common/money/amount.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
} from './../src/common/interceptors/idempotency.interceptor.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import { UserStatus } from './../src/generated/prisma/enums.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { RedisService } from './../src/redis/redis.service.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';
import {
  StellarAccountNotFoundError,
  type StellarBalanceLine,
} from './../src/wallet/stellar/account-source.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Steps 24 and 25 over real HTTP, against the real database and the real Redis: exactly one
 * `transactions` row per idempotency key, and no overdraft when two payments for one wallet are
 * forced to race.
 *
 * Both claims are about *rows*, so both are asserted against the database rather than against a
 * response body. A test that read the interceptor's code, or only the status code of the second
 * request, could pass while two rows existed - which is the failure this step is about.
 *
 * ## What is substituted, and what is not
 *
 * The app is the real `AppModule`: real Postgres, real Redis, the global validation pipe, the
 * shared exception filter, the JWT guard, the real `PrismaService.$transaction` with its raw
 * `SELECT ... FOR UPDATE`, and the real `BalancesService`. Three providers are replaced, and each
 * is a thing a test cannot have:
 *
 * - `SMS_SENDER`, because a code has to be read from somewhere (`auth.e2e-spec.ts` does the same).
 * - `AccountProvisioningService`, so verification does not reach KMS and Horizon - the wallet rows
 *   this file needs are written directly, with keys the fake balance source below recognises.
 * - `StellarService`, which is the *Horizon seam*: the one substitution this file's subject
 *   depends on. A funded Testnet wallet is not a fixture a test can create, and the overdraft
 *   check is arithmetic against a known balance - so the network is faked and everything above it
 *   (the account row, the trustline decision, `readBalances`, the available-amount calculation,
 *   the lock, the insert) runs for real.
 *
 * ## The race, and how it is forced
 *
 * `test/wallet.e2e-spec.ts` compares the API against Testnet; this file has to do the opposite -
 * hold the wallet's balance still while several payments are in flight at once. Concurrency comes
 * from sending the requests without awaiting them, which is the same shape as a real double-tap
 * and the same shape the lock exists for. The lock's own mutation test (delete `FOR UPDATE`, watch
 * this file fail) is recorded in `docs/build-sequence.md` rather than re-run here, because it
 * needs the source edited.
 *
 * ## Running it
 *
 * Local-only, like the other e2e files: it needs the compose stack (`docker compose up -d postgres
 * redis`) and a `.env`. It is not part of CI. `npm run test:e2e test/payments.e2e-spec.ts`.
 */

/** The one route under test, and the two auth routes used to build accounts. */
const PAYMENTS_PATH = `/${GLOBAL_PREFIX}/payments`;
const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;

/** Captures what would have been texted, so the verification code is readable here. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  latestFor(phoneNumber: string): SmsMessage | undefined {
    const messages = this.sent.filter((message) => message.to === phoneNumber);

    return messages[messages.length - 1];
  }
}

const smsSender = new CapturingSmsSender();

/** `AccountProvisioningService`, replaced: no KMS, no Horizon, no Testnet account. */
class RecordingProvisioning {
  readonly provisioned: string[] = [];

  async provisionFor(userId: string): Promise<ProvisioningOutcome> {
    this.provisioned.push(userId);

    return {
      status: 'provisioned',
      accountId: `account-${userId}`,
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      funding: 'funded',
      fundingTransactionHash: 'funding-hash',
      trustlineTransactionHash: 'trustline-hash',
    };
  }
}

const provisioning = new RecordingProvisioning();
/**
 * Horizon, replaced by a map of balances.
 *
 * Keyed by public key so two accounts can hold different amounts in one run - which is what makes
 * "this wallet cannot cover it" and "this one can" two tests rather than one. A key the map does
 * not know is the unfunded case, reported the way the real source reports it
 * (`StellarAccountNotFoundError`), so `BalancesService`'s "not on the ledger yet" path is
 * exercised rather than avoided.
 */
class FakeStellar {
  /** The issuer every reported USDC line carries - set from the app's own configuration. */
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

  network(): string {
    return 'TESTNET';
  }
}

const stellar = new FakeStellar();

/** A number this run has not registered, in the local spelling. */
function freshLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/** `+233241234567` from `0241234567`, asserted without the normalizer's help. */
function toE164(localNumber: string): string {
  const withoutTrunkPrefix = localNumber.replace(/^0/, '');

  expect(withoutTrunkPrefix).toMatch(/^2\d{8}$/);

  return `+233${withoutTrunkPrefix}`;
}

/** The single code in an SMS body. */
function codeFrom(body: string): string {
  const matches = body.match(/\d{6}/g) ?? [];

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

/** The half of a session response this file needs. */
interface Session {
  userId: string;
  accessToken: string;
}

/** The parts of a response this file asserts about. */
interface PaymentResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Everything a registered account leaves behind, so `afterAll` can remove exactly that. */
const numbersWritten: string[] = [];
const claimedHandles: string[] = [];
const userIds: string[] = [];
const publicKeys: string[] = [];
/** Each sender's public key, so a test can move or withhold that wallet's balance. */
const wallets = new Map<string, string>();
/** The idempotency keys this run claimed in Redis, so its own keys can be deleted. */
const keysClaimed: Array<{ userId: string; key: string }> = [];
describe('Payment creation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;

  /** The two accounts that matter: who pays, and who is paid. */
  let sender: Session;
  let recipient: Session;
  /** A second sender with a wallet of its own, so one wallet's race cannot become another's. */
  let other: Session;

  /** The wallets' public keys, and the handle prefix this run owns. */
  let prefix = '';

  /** A row that exists only to prove the refusals: an account that may not be paid. */
  let suspendedId = '';

  /** The sender's public key, so a test can move or withhold its balance. */
  let senderPublicKey = '';

  /** `Idempotency-Key` values this run uses; fresh per request, so tests cannot interact. */
  function freshKey(): string {
    return randomUUID();
  }

  /** `POST /v1/payments`, without awaiting, so a test can send several at once. */
  function postPayment(
    actor: Session,
    body: Record<string, unknown>,
    key: string | undefined,
  ): Promise<PaymentResponse> {
    const sent = request(app.getHttpServer()).post(PAYMENTS_PATH);

    if (key !== undefined) {
      sent.set(IDEMPOTENCY_KEY_HEADER, key);
      keysClaimed.push({ userId: actor.userId, key });
    }

    return sent
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body)
      .then((response) => ({
        status: response.status,
        headers: response.headers as Record<string, string>,
        body: response.body as Record<string, unknown>,
      }));
  }

  /** The rows written for one sender, oldest first. */
  function rowsFor(userId: string) {
    return prisma.transaction.findMany({
      where: { senderId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amount: true, status: true, idempotencyKey: true, recipientId: true },
    });
  }

  /**
   * What this sender has committed, straight from the database - the number the overdraft claim
   * is really about, and the one an assertion on response codes alone would miss entirely.
   */
  async function inFlightFor(userId: string): Promise<string> {
    const inFlight = await prisma.transaction.aggregate({
      where: { senderId: userId, status: { in: ['PENDING', 'PROCESSING'] } },
      _sum: { amount: true },
    });

    return inFlight._sum.amount === null
      ? '0'
      : Amount.fromDatabase(inFlight._sum.amount).toString();
  }

  /** Registers and verifies an account, the way a real user's is created. */
  async function registerAndVerify(local: string, e164: string, handle: string): Promise<Session> {
    const registration = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ phoneNumber: local, handle });

    expect(
      registration.status,
      `expected 201 from ${REGISTER_PATH}, got ${registration.status} ${JSON.stringify(
        registration.body,
      )}`,
    ).toBe(201);

    claimedHandles.push(handle.toLowerCase());

    const message = smsSender.latestFor(e164);

    expect(message, `no verification code was texted to ${e164}`).toBeDefined();

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: codeFrom((message as SmsMessage).body) })
      .expect(200);

    const session: Session = {
      userId: response.body.userId as string,
      accessToken: response.body.accessToken as string,
    };

    userIds.push(session.userId);

    return session;
  }

  /**
   * The `stellar_accounts` row a finished provisioning would have left, plus the balance the fake
   * Horizon will report for it. Written directly because `AccountProvisioningService` is
   * substituted - and because a *known* balance is the fixture this file cannot do without.
   */
  async function giveWallet(userId: string, balance: string): Promise<string> {
    const publicKey = `G${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 55)}`;

    await prisma.stellarAccount.create({
      data: {
        userId,
        publicKey,
        // Nothing in this file reads the envelope; the columns are NOT NULL, so a real
        // provisioning would always have left something here.
        encryptedSecretKey: 'cp-kms-1.test.test.test.test.test',
        dataKeyArn: 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-0000-0000-000000000000',
      },
      select: { id: true },
    });

    publicKeys.push(publicKey);
    wallets.set(userId, publicKey);
    stellar.balances.set(publicKey, balance);

    return publicKey;
  }

  /**
   * Puts a wallet back to "holds 10, nothing committed", so a test can state its own numbers
   * instead of inheriting whatever a previous test left in the table.
   *
   * The rows are deleted rather than ignored because they *are* the state this step's check reads
   * - a test that left them in place would be testing an accidental balance, and the assertions
   * after it would have to be written against a number nobody chose.
   */
  async function resetWallet(session: Session, balance = '10.0000000'): Promise<void> {
    await prisma.transaction.deleteMany({ where: { senderId: session.userId } });

    const publicKey = wallets.get(session.userId);

    if (publicKey === undefined) {
      throw new Error(`no wallet was recorded for ${session.userId}`);
    }

    stellar.balances.set(publicKey, balance);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .overrideProvider(StellarService)
      .useValue(stellar)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`: without the prefix the paths below 404, and without the pipe
    // a malformed body would reach the service instead of being refused at the door - which is one
    // of the things this file checks.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    // The same issuer `UsdcTrustlineService` compares the fake lines against, read from the app's
    // own configuration so the two cannot disagree.
    stellar.issuer = app.get(ConfigService).getOrThrow<string>('stellar.usdcIssuer');

    prefix = `p${randomInt(1000, 10000)}`;

    const handles = {
      sender: `${prefix}s`,
      recipient: `${prefix}r`,
      other: `${prefix}o`,
      suspended: `${prefix}x`,
    };
    claimedHandles.push(...Object.values(handles));

    const numbers = {
      sender: freshLocalNumber(),
      recipient: freshLocalNumber(),
      other: freshLocalNumber(),
      suspended: freshLocalNumber(),
    };
    const numbersE164 = Object.fromEntries(
      Object.entries(numbers).map(([who, local]) => [who, toE164(local)]),
    ) as Record<keyof typeof numbers, string>;

    numbersWritten.push(...Object.values(numbersE164));

    // The database outlives a run, so a number or handle left behind by a run that died would make
    // the first registration of this one a 409 - a failure with nothing to do with this file.
    await prisma.transaction.deleteMany({
      where: {
        OR: [
          { sender: { phoneNumber: { in: numbersWritten } } },
          { recipient: { phoneNumber: { in: numbersWritten } } },
        ],
      },
    });
    await prisma.stellarAccount.deleteMany({
      where: { user: { phoneNumber: { in: numbersWritten } } },
    });
    await prisma.user.deleteMany({ where: { phoneNumber: { in: numbersWritten } } });
    await prisma.user.deleteMany({ where: { handle: { in: claimedHandles } } });

    sender = await registerAndVerify(numbers.sender, numbersE164.sender, handles.sender);
    recipient = await registerAndVerify(
      numbers.recipient,
      numbersE164.recipient,
      handles.recipient,
    );
    other = await registerAndVerify(numbers.other, numbersE164.other, handles.other);

    senderPublicKey = await giveWallet(sender.userId, '10.0000000');
    await giveWallet(other.userId, '10.0000000');

    /**
     * The recipient is deliberately left without a `stellar_accounts` row: a recipient only has
     * to be payable, not wallet-provisioned, and a row here would invite the belief that this
     * file's balance fixture has anything to do with the receiving side.
     */
    const suspended = await prisma.user.create({
      data: {
        phoneNumber: numbersE164.suspended,
        handle: handles.suspended,
        status: UserStatus.SUSPENDED,
        phoneVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    suspendedId = suspended.id;
    userIds.push(suspended.id);
  }, 60_000);

  afterAll(async () => {
    /**
     * Transactions first: both relations are `ON DELETE RESTRICT` deliberately - the database
     * refuses to destroy payment history quietly - so a test that created some has to deal with
     * it in the honest order before the users can go.
     */
    await prisma.transaction.deleteMany({
      where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }] },
    });
    await prisma.stellarAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    // Redis keys are scoped by user id, so deleting the users above would have taken them out of
    // reach. This deletes exactly what this run claimed: `KEYS idempotency:*` would take a
    // developer's other keys with it, which is a surprise rather than a cleanup.
    if (redis !== undefined) {
      for (const { userId, key } of keysClaimed) {
        await redis.client.del(`idempotency:POST:/v1/payments:${userId}:${key}`);
      }
    }

    await app.close();
  }, 60_000);

  it('serves the route to a signed-out caller with a 401, and writes nothing', async () => {
    const before = await rowsFor(sender.userId);

    await request(app.getHttpServer())
      .post(PAYMENTS_PATH)
      .set(IDEMPOTENCY_KEY_HEADER, freshKey())
      .send({ recipientId: recipient.userId, amount: '1' })
      .expect(401);

    expect(await rowsFor(sender.userId)).toHaveLength(before.length);
  });

  describe('Step 24: one key, one transaction', () => {
    it('answers a retry of the same request with the same transaction, and writes no second row', async () => {
      const key = freshKey();
      const body = { recipientId: recipient.userId, amount: '1.5000000' };

      const first = await postPayment(sender, body, key);
      const retry = await postPayment(sender, body, key);

      // Byte-identical bodies: the retry is the *same request*, which is what a key names.
      expect(first.status).toBe(202);
      expect(retry.status).toBe(202);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
      // The fresh response carries no marker, so a client can tell the two apart.
      expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();

      const rows = await rowsFor(sender.userId);
      const matching = rows.filter((row) => row.idempotencyKey === key);

      expect(matching).toHaveLength(1);
      expect(matching[0]?.id).toBe(first.body.id);
      // The canonical form of the amount reached the column, not the spelling the client used.
      expect(matching[0]?.amount.toString()).toBe('1.5');
      expect(matching[0]?.status).toBe('PENDING');
      expect(matching[0]?.recipientId).toBe(recipient.userId);
    });

    it('produces exactly one row for two rapid duplicate requests sent without awaiting', async () => {
      const key = freshKey();
      const body = { recipientId: recipient.userId, amount: '2' };

      // Both requests in flight at once with the same key: the `SET NX` claim is what decides
      // which one runs, and the second is either a replay (if the first finished first) or a 409
      // (while it is still running). Which of the two it is, is timing - that it cannot create a
      // second row is not.
      const [left, right] = await Promise.all([
        postPayment(sender, body, key),
        postPayment(sender, body, key),
      ]);

      const responses = [left, right];
      const accepted = responses.filter((response) => response.status === 202);
      const refused = responses.filter((response) => response.status === 409);

      expect(accepted.length).toBeGreaterThanOrEqual(1);
      expect(accepted.length + refused.length).toBe(2);
      expect(
        responses.every((response) => response.status === 202 || response.status === 409),
      ).toBe(true);

      // Every 202 carries the same transaction - there is only one to carry.
      expect(new Set(accepted.map((response) => response.body.id)).size).toBe(1);

      const matching = (await rowsFor(sender.userId)).filter((row) => row.idempotencyKey === key);

      // The claim in the tests' own words: exactly one `Transaction` row for this key.
      expect(matching).toHaveLength(1);
      expect(matching[0]?.id).toBe(accepted[0]?.body.id);

      // A 409, when it happens, says what it is: in flight, not failed.
      for (const response of refused) {
        expect(String(response.body.message)).toMatch(/already in flight/);
      }
    }, 30_000);

    it('refuses the same key with a different body, and still writes one row', async () => {
      const key = freshKey();

      const first = await postPayment(sender, { recipientId: recipient.userId, amount: '3' }, key);
      const different = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '4' },
        key,
      );

      expect(first.status).toBe(202);
      // Replaying the first answer here would tell the client a payment happened that it did not
      // ask for; the key names the *request*, not the endpoint.
      expect(different.status).toBe(400);
      expect(String(different.body.message)).toMatch(/different request/);

      const matching = (await rowsFor(sender.userId)).filter((row) => row.idempotencyKey === key);

      expect(matching).toHaveLength(1);
      expect(matching[0]?.amount.toString()).toBe('3');
    });

    it('refuses a request with no Idempotency-Key at all, before writing anything', async () => {
      const before = await rowsFor(sender.userId);

      const response = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '1' },
        undefined,
      );

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/requires an `Idempotency-Key`/);
      expect(await rowsFor(sender.userId)).toHaveLength(before.length);
    });

    it('lets the same key be reused after the request it named was refused', async () => {
      const key = freshKey();
      // A refusal releases the claim (the interceptor does it, and the e2e proves it): the client
      // is allowed to fix the request and send it again with the same key.
      const refused = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '999999' },
        key,
      );

      expect(refused.status).toBe(409);

      const retried = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '1' },
        key,
      );

      expect(retried.status).toBe(202);

      const matching = (await rowsFor(sender.userId)).filter((row) => row.idempotencyKey === key);

      expect(matching).toHaveLength(1);
      expect(matching[0]?.amount.toString()).toBe('1');
    });
  });

  describe('Step 25: the forced race does not allow an overdraft', () => {
    it('lets exactly three of five concurrent payments through, and never commits more than the wallet holds', async () => {
      // A wallet of 10, five payments of 3 for the same wallet, all sent without awaiting: 3 fit
      // (9) and the fourth would take the committed total to 12. Which three is timing; that the
      // total cannot exceed 10 is the claim.
      const attempts = await Promise.all(
        [0, 1, 2, 3, 4].map(() =>
          postPayment(other, { recipientId: recipient.userId, amount: '3' }, freshKey()),
        ),
      );

      const accepted = attempts.filter((response) => response.status === 202);
      const refused = attempts.filter((response) => response.status === 409);

      expect(accepted).toHaveLength(3);
      expect(refused).toHaveLength(2);

      // The refusal carries the spendable figure, so the client can render "you can send up to X"
      // instead of guessing - and it is the *committed* figure, not the wallet's balance.
      expect(String(refused[0]?.body.message)).toMatch(/Available to spend/);

      // And the number that matters, read from the database rather than from the responses.
      expect(await inFlightFor(other.userId)).toBe('9');
      expect((await rowsFor(other.userId)).filter((row) => row.status === 'PENDING')).toHaveLength(
        3,
      );

      // Every response body agrees with the rows: one transaction per accepted request, each of
      // them 3, and no row for a refused one.
      const ids = new Set(accepted.map((response) => response.body.id as string));

      expect(ids.size).toBe(3);
    }, 60_000);

    it('refuses a single payment that cannot be covered, and writes nothing', async () => {
      // A wallet with 10 and nothing committed: this sender's earlier tests in this file left
      // rows behind, and they are exactly the state this check reads.
      await resetWallet(sender);

      const response = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '10.0000001' },
        freshKey(),
      );

      expect(response.status).toBe(409);
      expect(String(response.body.message)).toContain('10.');
      expect(await rowsFor(sender.userId)).toHaveLength(0);
    });

    it('counts money already in flight, which Horizon cannot see', async () => {
      await resetWallet(sender);

      // A PENDING row written straight into the table, as a previous request would have left it:
      // the wallet's 10 is unchanged on the network, and 4.0000001 more must not be allowed.
      await prisma.transaction.create({
        data: {
          senderId: sender.userId,
          recipientId: recipient.userId,
          amount: '6',
          status: 'PENDING',
          idempotencyKey: freshKey(),
        },
        select: { id: true },
      });

      const response = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '4.0000001' },
        freshKey(),
      );

      expect(response.status).toBe(409);
      expect(String(response.body.message)).toContain('4.');

      // Exactly at the remaining 4 is allowed, so the check is the boundary and not a margin.
      const fits = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '4' },
        freshKey(),
      );

      expect(fits.status).toBe(202);
      expect(await inFlightFor(sender.userId)).toBe('10');
    }, 30_000);

    it('answers 400, not 500, for a wallet the network has never seen', async () => {
      // The row exists and Horizon has never heard of the key: provisioning stopped between
      // sealing the key and funding it (Step 19's `funded: false`). The spendable amount is
      // unknown rather than zero, and the answer is a refusal that names the reason.
      stellar.balances.delete(senderPublicKey);

      try {
        const response = await postPayment(
          sender,
          { recipientId: recipient.userId, amount: '1' },
          freshKey(),
        );

        expect(response.status).toBe(400);
        expect(String(response.body.message)).toMatch(/cannot hold USDC/);
      } finally {
        stellar.balances.set(senderPublicKey, '10.0000000');
      }
    });
  });

  describe('Step 25: what it writes and what it refuses', () => {
    it('round-trips a crafted 7-decimal amount through the endpoint, the column and the response', async () => {
      // The value `money.e2e-spec.ts` uses to show what a float cannot carry, sent over HTTP this
      // time: the endpoint parses it, Prisma writes it, Postgres stores it and the response reads
      // it back from the row. A bigger wallet is set for the length of this test only, because
      // this sender holds 10.
      const crafted = '123456789012.1234567';

      stellar.balances.set(senderPublicKey, '9999999999999.9999999');

      try {
        const response = await postPayment(
          sender,
          { recipientId: recipient.userId, amount: crafted },
          freshKey(),
        );

        expect(response.status).toBe(202);
        expect(response.body).toEqual({
          id: expect.any(String),
          status: 'PENDING',
          amount: crafted,
          recipientId: recipient.userId,
          createdAt: expect.any(String),
        });

        const row = await prisma.transaction.findUniqueOrThrow({
          where: { id: response.body.id as string },
          select: { amount: true },
        });

        // Byte-for-byte in the column, read back through the same canonical form that answered the
        // request. The row is left for `afterAll`, with the rest of this sender's.
        expect(row.amount.toString()).toBe(crafted);
      } finally {
        stellar.balances.set(senderPublicKey, '10.0000000');
      }
    });

    it('refuses a recipient who cannot be paid, in the sentence the confirmation endpoint uses', async () => {
      const response = await postPayment(
        sender,
        { recipientId: suspendedId, amount: '1' },
        freshKey(),
      );

      // One 404 for suspended, unverified and unknown alike: a payment endpoint that answered
      // differently could be used to ask which ids exist.
      expect(response.status).toBe(404);
      expect(String(response.body.message)).toBe(
        'No Cashping account with that id can receive money. Check the id, or search again.',
      );
    });

    it('refuses a payment to the sender themselves', async () => {
      const response = await postPayment(
        sender,
        { recipientId: sender.userId, amount: '1' },
        freshKey(),
      );

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/someone else/);
    });

    it('refuses a body that carries a client-computed total, and uses nothing from it', async () => {
      const key = freshKey();
      const before = await rowsFor(sender.userId);

      const response = await postPayment(
        sender,
        { recipientId: recipient.userId, amount: '1', total: '0.0000001' },
        key,
      );

      // The DTO declares two fields and the global pipe refuses anything else: a request built on
      // "my client added it up" is not silently reinterpreted, and nothing it carried can reach
      // the row.
      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/total/);
      expect(
        (await rowsFor(sender.userId)).filter((row) => row.idempotencyKey === key),
      ).toHaveLength(0);
      expect(await rowsFor(sender.userId)).toHaveLength(before.length);
    });

    it('refuses an amount the ledger cannot hold, with the reason, and writes nothing', async () => {
      const before = await rowsFor(sender.userId);

      for (const amount of ['1.50000000', '99999999999999', '0', '-1']) {
        const response = await postPayment(
          sender,
          { recipientId: recipient.userId, amount },
          freshKey(),
        );

        expect(response.status, `expected 400 for ${amount}`).toBe(400);
      }

      expect(await rowsFor(sender.userId)).toHaveLength(before.length);
    });
  });
});
