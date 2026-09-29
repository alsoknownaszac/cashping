import { createHash, randomInt } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { RedisService } from './../src/redis/redis.service.js';

/**
 * Step 20 against the real thing: the two wallet endpoints over HTTP, on a wallet that was
 * provisioned by a real registration, compared with Horizon for the same account.
 *
 * This is the file the Day 2 audit checklist asks for - "balance endpoint reflects the real
 * Horizon-reported USDC balance, not a cached/stale/default value - verify by comparing
 * directly against a Horizon query for the same account" - and it is also what closes the
 * Day 2 "Done when": a freshly registered, phone-verified user has a funded Testnet account
 * with an active USDC trustline, *visible via the balance endpoint*.
 *
 * ## Nothing is substituted except the SMS
 *
 * The app is the real `AppModule`: real Postgres, real KMS endpoint, real Horizon, real
 * provisioning (so `verifyOtp` triggers it exactly as it does in production, which is what
 * makes "without further action" a fact rather than an assertion about a fake). The one
 * replacement is `SMS_SENDER`, because a code has to be read from somewhere and a test
 * cannot receive a text. Everything else in the chain - the OTP, the session, the JWT, the
 * guard, the Horizon read - is the production path.
 *
 * ## The comparison is against the network, not against the code
 *
 * Every number the API reports is compared with a plain `fetch` to Horizon that does not go
 * through this codebase, for the *same* account: the USDC balance string, the XLM balance,
 * and the asset's issuer (taken from Horizon's own `asset_issuer`, not from configuration,
 * so a mistake in the configured issuer could not hide behind itself). Both are strings, so
 * the comparison is exact - there is no tolerance for a rounding bug to hide in.
 *
 * The third test is the "not stale" half, and it is the one a comparison alone cannot make:
 * it *moves the ledger* (Horizon's hosted friendbot pays a repeat request, recorded in
 * `FriendbotFunder`) and shows both the new number and its agreement with a fresh Horizon
 * query. A cached or defaulted response would keep answering the old one.
 *
 * ## Running it
 *
 * Skipped unless `RUN_STELLAR_IT=1`, so neither `npm test` nor CI needs a socket, a database
 * or a KMS endpoint. The app's own config is used, with the process environment winning over
 * `.env` (`ConfigModule` merges in that order), so what has to be exported is the part
 * `.env` cannot know:
 *
 * ```bash
 * export AWS_REGION=eu-west-1
 * export AWS_ENDPOINT_URL=http://localhost:5055            # a KMS endpoint (Moto/LocalStack)
 * export AWS_KMS_KEY_ID=<an arn that exists in the endpoint above>   # overrides .env's placeholder
 * RUN_STELLAR_IT=1 npm run test:e2e test/wallet.e2e-spec.ts
 * ```
 *
 * `DATABASE_URL` and `STELLAR_USDC_ISSUER` come from `.env`; the compose Postgres is on
 * 5433 and the USDC issuer is Circle's Testnet one.
 *
 * ## What it leaves behind
 *
 * One `users` row and one `stellar_accounts` row, both deleted again in `afterAll` (the
 * account row first: the relation is `onDelete: Restrict`). The Testnet account itself
 * cannot be deleted - it stays on the ledger, funded and trusting USDC, with a seed nobody
 * holds, plus the second funding this file sends it. That is a Testnet-only cost, and it is
 * why this file provisions exactly one account per run.
 */

const ENABLED = process.env['RUN_STELLAR_IT'] === '1';

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
const ACCOUNT_PATH = `/${GLOBAL_PREFIX}/wallet/account`;
const BALANCE_PATH = `/${GLOBAL_PREFIX}/wallet/balance`;

/** What the two endpoints are compared against, fetched without going through the app. */
interface HorizonAccount {
  readonly sequence: string;
  readonly balances: ReadonlyArray<{
    readonly asset_type: string;
    readonly asset_code?: string;
    readonly asset_issuer?: string;
    readonly balance: string;
    readonly is_authorized?: boolean;
  }>;
}

/** Captures what would have been texted, so the verification code is readable here. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `wallet-e2e-${this.sent.length}` };
  }

  for(phoneNumber: string): SmsMessage[] {
    return this.sent.filter((message) => message.to === phoneNumber);
  }
}

const smsSender = new CapturingSmsSender();

/** A Ghanaian mobile that has never been registered, in the reserved `024…` range. */
function uniqueLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/** `+233241234567` from `0241234567`, asserted without the normalizer's help. */
function toE164(localNumber: string): string {
  return `+233${localNumber.replace(/^0/, '')}`;
}

/** The newest code texted to `phoneNumber`, failing if there is none. */
function latestCodeFor(phoneNumber: string): string {
  const messages = smsSender.for(phoneNumber);
  const message = messages[messages.length - 1];

  if (message === undefined) {
    throw new Error(`no SMS was captured for ${phoneNumber}`);
  }

  const matches = message.body.match(/\d{6}/g) ?? [];

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

/** Horizon's own answer for an account, fetched without going through any of the app. */
async function horizonAccount(publicKey: string): Promise<HorizonAccount> {
  const response = await fetch(`${horizonUrl()}/accounts/${publicKey}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Horizon answered HTTP ${response.status} for ${publicKey}`);
  }

  return (await response.json()) as HorizonAccount;
}

function horizonUrl(): string {
  return process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org';
}

/**
 * Pays a funded Testnet account its starting balance again, through Horizon's hosted
 * friendbot.
 *
 * This is a deliberate *mutation* of the ledger, and the only reason the "not stale" claim
 * can be made at all: `friendbot.stellar.org` refuses a repeat request, but
 * `horizon-testnet.stellar.org/friendbot` pays one (both behaviours are recorded in
 * `FriendbotFunder`). So this is the one lever this environment has for changing a balance
 * without a second funded account to send from - and 10,000 Testnet XLM is not money.
 */
async function fundAgain(publicKey: string): Promise<void> {
  const response = await fetch(`${horizonUrl()}/friendbot?addr=${publicKey}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `friendbot answered HTTP ${response.status} for ${publicKey}: ${await response.text()}`,
    );
  }
}

/** A credit line as Horizon reports it, with the issuer narrowed to a string. */
type HorizonCreditLine = HorizonAccount['balances'][number] & { asset_issuer: string };

/** Horizon's native line, failing loudly rather than comparing against nothing. */
function nativeLineOf(account: HorizonAccount): HorizonAccount['balances'][number] {
  const line = account.balances.find((candidate) => candidate.asset_type === 'native');

  if (line === undefined) {
    throw new Error('Horizon reported no native balance: is the account funded at all?');
  }

  return line;
}

/**
 * The USDC line Horizon reported, whatever issuer it is from.
 *
 * Deliberately not filtered by the *configured* issuer: the assertion this feeds is that the
 * endpoint's answer agrees with the network's, and filtering by configuration first would let
 * a wrong configured issuer agree with itself.
 */
function usdcLineOf(account: HorizonAccount): HorizonCreditLine {
  const line = account.balances.find(
    (candidate) => candidate.asset_code === 'USDC' && candidate.asset_issuer !== undefined,
  );

  if (line === undefined) {
    throw new Error('Horizon reported no USDC line for this account: the trustline is gone');
  }

  return line as HorizonCreditLine;
}

/**
 * One live run, in four tests that share state: what the first test registers and verifies
 * is what the others read. Ordered rather than independent because the shared state *is* the
 * point - the account the endpoints report on has to be one a real registration created.
 */
describe.skipIf(!ENABLED)('wallet endpoints against Testnet (e2e, live)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: RedisService;

  /** Set by the verification test; everything after it reads these. */
  let accessToken = '';
  let userId = '';
  let publicKey = '';
  let phoneNumber = '';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      // The one substitution in the whole file: a code has to be readable somewhere, and a
      // test cannot receive a text. See the header for what is deliberately *not* replaced.
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, in the same order: without the prefix these paths 404,
    // and without the pipe a malformed body reaches the service instead of the door.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    // The account row first: `onDelete: Restrict` refuses to delete the user until it is
    // gone, which is the schema insisting a funded Stellar account is not deleted casually.
    if (userId !== '') {
      await prisma.stellarAccount.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }

    /**
     * The per-number send allowance outlives the row it was spent on (the key is
     * `otp:requests:<sha256>`, keyed by the number, with a fixed window), so a number that
     * hit the limit in this run would start the next run three sends down. Derived exactly
     * as the limiter derives it, and deleted by name rather than by pattern: `KEYS` is the
     * O(N) call the limiter's own comment avoids.
     */
    if (phoneNumber !== '') {
      const counterKey = `otp:requests:${createHash('sha256').update(phoneNumber).digest('hex')}`;

      await redis.client.del(counterKey);
    }

    await app?.close();
  });

  it('refuses both endpoints without a token', async () => {
    // Over real HTTP, through the real guard: the routes exist, and neither of them answers
    // anything about anybody without an access token.
    await request(app.getHttpServer()).get(ACCOUNT_PATH).expect(401);
    await request(app.getHttpServer()).get(BALANCE_PATH).expect(401);
  });

  it('has a wallet by the time a newly registered number is verified', async () => {
    const local = uniqueLocalNumber();
    phoneNumber = toE164(local);

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);

    const code = latestCodeFor(phoneNumber);

    const verified = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(200);

    userId = verified.body.userId as string;
    accessToken = verified.body.accessToken as string;

    // Provisioning ran *inside* that request (Step 19), which is what "without further
    // action" means: the row exists, and its key is the one the endpoints report on.
    const row = await prisma.stellarAccount.findUnique({ where: { userId } });
    publicKey = row?.publicKey ?? '';

    expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);

    const account = await request(app.getHttpServer())
      .get(ACCOUNT_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(account.body).toMatchObject({
      accountId: row?.id,
      publicKey,
      network: 'TESTNET',
      funded: true,
    });
    // Funded for real: the XLM is Horizon's number, and it is not zero.
    expect(Number(account.body.nativeBalance)).toBeGreaterThan(0);
  }, 120_000);

  it('reports the USDC balance Horizon reports, for the same account', async () => {
    expect(publicKey).not.toBe('');

    const native = nativeLineOf(await horizonAccount(publicKey));
    const usdc = usdcLineOf(await horizonAccount(publicKey));

    const balance = await request(app.getHttpServer())
      .get(BALANCE_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // The audit item, as an equality over the whole body: the endpoint's USDC balance *is*
    // the string Horizon reports for this account (not a number that happens to be close),
    // and the issuer is the one Horizon's own line names - not the configured value, so a
    // wrong `STELLAR_USDC_ISSUER` could not agree with itself here.
    expect(balance.body).toEqual({
      asset: { code: 'USDC', issuer: usdc.asset_issuer },
      balance: usdc.balance,
      trustline: 'active',
      funded: true,
    });

    const account = await request(app.getHttpServer())
      .get(ACCOUNT_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // The same for XLM: two numbers, two sources, and an exact string comparison of each.
    expect(account.body.nativeBalance).toBe(native.balance);

    console.log(
      `[step 20] balance account=${publicKey} usdc=${usdc.balance} xlm=${native.balance} ` +
        `issuer=${usdc.asset_issuer} horizon_authorized=${usdc.is_authorized === true} ` +
        `endpoint_trustline=active endpoint_funded=true (both numbers match Horizon)`,
    );
  }, 60_000);

  it('follows the ledger: a second funding moves the number both sides report', async () => {
    expect(publicKey).not.toBe('');

    const before = await request(app.getHttpServer())
      .get(ACCOUNT_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Deliberately move the ledger - the one lever this environment has for changing a
    // balance, and the reason "not stale" can be shown rather than asserted.
    await fundAgain(publicKey);

    const after = await request(app.getHttpServer())
      .get(ACCOUNT_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const native = nativeLineOf(await horizonAccount(publicKey));

    // A defaulted response would still be answering whatever it answered first; a cached one
    // would answer a number Horizon no longer reports. These two assertions exclude both:
    // the value moved, and it moved to exactly what Horizon says now.
    expect(Number(after.body.nativeBalance)).toBeGreaterThan(Number(before.body.nativeBalance));
    expect(after.body.nativeBalance).toBe(native.balance);

    // The USDC side is re-read on the same request path, and still agrees - the endpoint did
    // not stop reporting one asset because the other changed.
    const usdc = usdcLineOf(await horizonAccount(publicKey));
    const balance = await request(app.getHttpServer())
      .get(BALANCE_PATH)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(balance.body.balance).toBe(usdc.balance);
    expect(balance.body.trustline).toBe('active');

    // And it is the same wallet: the funding moved the money, not the identity.
    expect(after.body.publicKey).toBe(before.body.publicKey);

    console.log(
      `[step 20] fresh read xlm ${before.body.nativeBalance} -> ${after.body.nativeBalance} ` +
        `(Horizon agrees at ${native.balance}); usdc=${usdc.balance} unchanged, ` +
        `account=${after.body.publicKey}`,
    );
  }, 120_000);
});
