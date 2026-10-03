import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { IDEMPOTENCY_KEY_HEADER } from './../src/common/interceptors/idempotency.interceptor.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import {
  STEP_UP_TOKEN_ALGORITHM,
  STEP_UP_TOKEN_AUDIENCE,
  STEP_UP_TOKEN_HEADER,
  STEP_UP_TOKEN_ISSUER,
  type StepUpTokenClaims,
} from './../src/identity/pin/step-up-token.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';

/**
 * Step 34a, over real HTTP: the transaction PIN as a second factor.
 *
 * Four claims are made here, and each of them is a sentence rather than an implementation
 * detail:
 *
 * 1. **Registration collects the PIN, and stores a hash rather than the digits.** The column
 *    is asserted directly, because "we hash it" is the kind of claim that survives review
 *    and not a refactor.
 * 2. **Proving the PIN is what a payment needs.** `POST /v1/auth/pin/verify` answers a
 *    step-up token; `POST /v1/payments` refuses without one. The refusals are asserted one
 *    per way a token can be wrong (absent, not ours, expired, another account's) because
 *    that set *is* the guard.
 * 3. **Guessing is expensive and bounded.** Five wrong PINs lock the PIN, the correct PIN
 *    does not unlock it early, and a malformed body never counts as a guess.
 * 4. **The PIN never leaves.** Not in a response, not in an error message, and not in the
 *    audit rows the failures write.
 *
 * Local-only, and it needs the compose stack (`docker compose up -d postgres redis`) plus a
 * `.env`, because it boots `AppModule`: the cryptography, Prisma, Redis and the validation
 * pipe are the production ones. Only two providers are replaced - the SMS sender, so the
 * verification code can be read from the captured message, and wallet provisioning, so a
 * verify does not reach KMS and Horizon (see `RecordingProvisioning` in
 * `auth.e2e-spec.ts` for the full argument). Run it with `npm run test:e2e`.
 *
 * What this file deliberately does *not* assert is a payment that is actually created: that
 * needs a funded wallet and a substituted Horizon, and it lives in
 * `test/payments.e2e-spec.ts`, where every payment now carries the header this file is
 * about. What is asserted here is the gate itself - refused without a usable token,
 * *passed* with one (the 400 in the last test is the validation pipe answering from behind
 * the guard, which is what "passed" looks like without a wallet).
 */

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const OTP_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
const PIN_CHANGE_PATH = `/${GLOBAL_PREFIX}/auth/pin/change`;
const PIN_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/pin/verify`;
const PAYMENTS_PATH = `/${GLOBAL_PREFIX}/payments`;

/** The PIN registration collects, and one that is not it. */
const PIN = '1234';
const WRONG_PIN = '9173';

/** The policy this file relies on, mirroring `configuration()`. */
const PIN_MAX_ATTEMPTS = 5;
const STEP_UP_TOKEN_TTL_MINUTES = 5;

/** Seconds in a minute, for minting a token that expired before it was sent. */
const SECONDS_PER_MINUTE = 60;

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

/** One account this file created, and the two credentials its tests need. */
interface Account {
  userId: string;
  accessToken: string;
  /** The E.164 form, which is what the cleanup deletes by. */
  phoneNumber: string;
}

describe('Transaction PIN and step-up (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** Every number this run registered, so `afterAll` removes exactly what it created. */
  const registered: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, in the same order - without the pipe a malformed PIN
    // would reach the hasher and the attempt counter instead of being refused at the door,
    // which is one of the claims below.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // The unique index on `phone_number` is what makes this necessary: a leftover row turns
    // the next run's first registration into a 409. The audit rows are left alone on
    // purpose - `audit_logs` has no foreign key to `users`, so they are the record that
    // outlives the account, which is the point of the table.
    const { count } = await prisma.user.deleteMany({ where: { phoneNumber: { in: registered } } });

    expect(count, 'every number this run created should have been removed').toBe(registered.length);

    await app.close();
  }, 60_000);

  /**
   * Registers a number with a PIN and verifies it, the way a real first session is created.
   *
   * The PIN is a parameter rather than the constant because two tests need two accounts on
   * the same PIN (one for the salt assertion, one for a fresh lockout).
   */
  async function registerAndVerify(pin: string): Promise<Account> {
    const local = freshLocalNumber();
    const e164 = toE164(local);

    registered.push(e164);

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ pin, phoneNumber: local }).expect(201);

    const message = smsSender.latestFor(e164);

    if (message === undefined) {
      throw new Error(`no verification code was texted to ${e164}`);
    }

    const verified = await request(app.getHttpServer())
      .post(OTP_VERIFY_PATH)
      .send({ phoneNumber: local, code: codeFrom(message.body) })
      .expect(200);

    return {
      userId: verified.body.userId as string,
      accessToken: verified.body.accessToken as string,
      phoneNumber: e164,
    };
  }

  /** The bearer header every PIN route needs. */
  function as(account: Account): { authorization: string } {
    return { authorization: `Bearer ${account.accessToken}` };
  }

  /** The PIN columns, read straight out of the row the API wrote. */
  function pinRow(userId: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        transactionPinHash: true,
        transactionPinSetAt: true,
        transactionPinAttempts: true,
        transactionPinLockedUntil: true,
      },
    });
  }

  /**
   * Every audit row this run wrote for one account, oldest first.
   *
   * Read by `userId` rather than by subject, and deliberately unfiltered by action: the
   * assertions below are about what the *whole* log says about a PIN - "no row anywhere
   * contains these four digits" is not a claim a filtered read can make.
   */
  function auditRows(userId: string) {
    return prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, outcome: true, metadata: true },
    });
  }

  /**
   * Takes the PIN away underneath an account, to reach the state a Google-SSO account
   * starts in (Step 34d) - the one state a registered account cannot be in from outside.
   * Written directly because there is no endpoint that unsets a PIN, and there should not
   * be: this is a fixture, not a supported transition.
   */
  async function forgetPin(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { transactionPinHash: null, transactionPinSetAt: null },
    });
  }

  describe('registration', () => {
    it('refuses a registration with no PIN, and creates nothing', async () => {
      const local = freshLocalNumber();
      const e164 = toE164(local);

      const response = await request(app.getHttpServer())
        .post(REGISTER_PATH)
        .send({ phoneNumber: local })
        .expect(400);

      expect(String(response.body.message)).toMatch(/pin/i);

      // The number is deliberately *not* recorded for cleanup: nothing was created, and the
      // `afterAll` count is a claim about every number this run really registered.
      expect(await prisma.user.findUnique({ where: { phoneNumber: e164 } })).toBeNull();
    });

    it('refuses a PIN that is not exactly four digits, at the door', async () => {
      for (const pin of ['123', '12345', '12a4', 'abcd', '']) {
        // A fresh number per candidate, so the row check below is on a number nothing
        // touched: a refused body has to leave no account behind, not a half-made one.
        const local = freshLocalNumber();

        await request(app.getHttpServer())
          .post(REGISTER_PATH)
          .send({ pin, phoneNumber: local })
          .expect(400);

        expect(await prisma.user.findUnique({ where: { phoneNumber: toE164(local) } })).toBeNull();
      }
    });

    it('stores a salted scrypt hash of the PIN, never the digits', async () => {
      const first = await registerAndVerify(PIN);

      const row = await pinRow(first.userId);

      expect(row.transactionPinHash).toMatch(/^scrypt\$/);
      expect(row.transactionPinHash).not.toContain(PIN);
      expect(row.transactionPinSetAt).toBeInstanceOf(Date);
      expect(row.transactionPinAttempts).toBe(0);
      expect(row.transactionPinLockedUntil).toBeNull();

      /**
       * ...and a second account on the same PIN gets a different hash, which is the salt.
       * Without it, matching rows in `users` would announce that two customers picked the
       * same four digits - and a table of every 4-digit PIN would find both at once.
       */
      const second = await registerAndVerify(PIN);

      expect((await pinRow(second.userId)).transactionPinHash).not.toBe(row.transactionPinHash);
    });
  });

  describe('POST /v1/auth/pin/verify', () => {
    it('answers a step-up token for the right PIN, with the step-up audience', async () => {
      const account = await registerAndVerify(PIN);

      const response = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(200);

      const claims = app
        .get(JwtService, { strict: false })
        .decode<StepUpTokenClaims>(response.body.stepUpToken as string);

      expect(claims.sub).toBe(account.userId);
      expect(claims.aud).toBe(STEP_UP_TOKEN_AUDIENCE);
      expect(claims.iss).toBe(STEP_UP_TOKEN_ISSUER);
      // The lifetime comes from `pin.stepUpTokenTtlMinutes`, and this is the assertion that
      // would fail if the token were quietly minted as a session token.
      expect(claims.exp - claims.iat).toBe(STEP_UP_TOKEN_TTL_MINUTES * SECONDS_PER_MINUTE);
      expect(Date.parse(response.body.stepUpTokenExpiresAt as string)).toBeGreaterThan(Date.now());

      // The response carries the token and when it dies, and nothing else: no PIN, no hash,
      // and no attempt count - a successful call has none left to report.
      expect(Object.keys(response.body as object).sort()).toEqual([
        'stepUpToken',
        'stepUpTokenExpiresAt',
      ]);
    });

    it('refuses a wrong PIN with a 401 that counts down, and logs the guess without the digits', async () => {
      const account = await registerAndVerify(PIN);

      const response = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: WRONG_PIN })
        .expect(401);

      expect(String(response.body.message)).toMatch(/not correct/i);
      expect(String(response.body.message)).toMatch(
        new RegExp(`${PIN_MAX_ATTEMPTS - 1} attempts remaining`),
      );
      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(1);

      const rows = await auditRows(account.userId);

      expect(rows[rows.length - 1]).toMatchObject({
        action: 'auth.pin.failed',
        outcome: 'failed',
        metadata: { context: 'verify', attemptsRemaining: PIN_MAX_ATTEMPTS - 1 },
      });

      // The claim the audit table is read for: a failed guess is recorded as an *event*,
      // never as the digits that were tried.
      expect(JSON.stringify(rows)).not.toContain(WRONG_PIN);
      expect(JSON.stringify(rows)).not.toContain(PIN);
    });

    it('does not count a malformed PIN as an attempt', async () => {
      const account = await registerAndVerify(PIN);

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: '123' })
        .expect(400);

      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(0);

      // Which is what this shows: a real wrong guess still has the whole allowance, so "a
      // client sent a malformed body" and "a client is guessing" stay different facts.
      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: WRONG_PIN })
        .expect(401);

      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(1);
    });

    it('locks the PIN after five wrong attempts, and the right PIN does not lift the lock', async () => {
      const account = await registerAndVerify(PIN);

      for (let attempt = 1; attempt <= PIN_MAX_ATTEMPTS - 1; attempt += 1) {
        const response = await request(app.getHttpServer())
          .post(PIN_VERIFY_PATH)
          .set(as(account))
          .send({ pin: WRONG_PIN })
          .expect(401);

        expect(String(response.body.message)).toMatch(
          new RegExp(`${PIN_MAX_ATTEMPTS - attempt} attempts remaining`),
        );
      }

      const locked = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: WRONG_PIN })
        .expect(429);

      expect(String(locked.body.message)).toMatch(/too many incorrect pin attempts/i);
      expect(String(locked.body.message)).toMatch(/try again after/i);

      const row = await pinRow(account.userId);

      // The fifth attempt locks *and* resets the counter: the counter measures one window,
      // and starting the next window at the maximum would mean an account that locks itself
      // again on its next mistake.
      expect(row.transactionPinAttempts).toBe(0);
      expect(row.transactionPinLockedUntil?.getTime()).toBeGreaterThan(Date.now());

      /**
       * The claim that makes the lock worth having: knowing the PIN does not help while it is
       * locked. The lock is checked before the hash, so the *correct* PIN is refused exactly
       * like a wrong one here - otherwise the allowance would be a speed bump rather than a
       * defence.
       */
      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(429);

      const failures = (await auditRows(account.userId)).filter(
        (entry) => entry.action === 'auth.pin.failed',
      );

      /**
       * Five rows, one per guess - and deliberately *not* six. The locked-but-correct attempt
       * above is refused before the hash is even read (`PinService.verify` checks the lock
       * first), so there was no comparison to record: a lock accounts for the guesses that
       * earned it rather than padding the log with the requests it turned away.
       */
      expect(failures).toHaveLength(PIN_MAX_ATTEMPTS);
      expect(failures[failures.length - 1]?.metadata).toMatchObject({
        context: 'verify',
        attemptsRemaining: 0,
      });
    });

    it('answers 409 when the account has no PIN to prove, without counting an attempt', async () => {
      const account = await registerAndVerify(PIN);

      await forgetPin(account.userId);

      const response = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(409);

      expect(String(response.body.message)).toMatch(/no transaction pin is set/i);
      // Nothing was guessed, so nothing was counted: otherwise anyone could lock an account
      // out of an endpoint it could not use yet anyway (the state Step 34d's SSO accounts
      // start in).
      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(0);
    });

    it('refuses a tokenless request, so the PIN cannot be proved without a session', async () => {
      await request(app.getHttpServer()).post(PIN_VERIFY_PATH).send({ pin: PIN }).expect(401);
    });
  });

  describe('POST /v1/auth/pin/change', () => {
    it('changes the PIN when the current one is given, and the old one stops working', async () => {
      const account = await registerAndVerify(PIN);
      const replacement = '5678';

      const changed = await request(app.getHttpServer())
        .post(PIN_CHANGE_PATH)
        .set(as(account))
        .send({ pin: replacement, currentPin: PIN })
        .expect(200);

      expect(changed.body.pinSetAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isNaN(Date.parse(changed.body.pinSetAt as string))).toBe(false);

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(401);

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: replacement })
        .expect(200);

      const rows = await auditRows(account.userId);
      const actions = rows.map((row) => row.action);

      expect(actions).toContain('auth.pin.changed');
      // The new digits are nowhere in the log either - a change records that it happened,
      // not what it was changed to. (`auth.pin.set` is the registration, as above.)
      expect(JSON.stringify(rows)).not.toContain(replacement);
    });

    it('refuses a change with no currentPin once a PIN is set, and the PIN in force still works', async () => {
      const account = await registerAndVerify(PIN);

      const response = await request(app.getHttpServer())
        .post(PIN_CHANGE_PATH)
        .set(as(account))
        .send({ pin: '5678' })
        .expect(409);

      // A fact about the account rather than the body: the same `{ pin }` is a valid *set* on
      // an account with no PIN. The status says "this conflicts with the state of the
      // resource", which is exactly what happened.
      expect(String(response.body.message)).toMatch(/already has a pin/i);
      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(0);

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(200);
    });

    it('refuses a wrong currentPin with a 409, counts it, and leaves the PIN in force', async () => {
      const account = await registerAndVerify(PIN);

      const response = await request(app.getHttpServer())
        .post(PIN_CHANGE_PATH)
        .set(as(account))
        .send({ pin: '5678', currentPin: WRONG_PIN })
        .expect(409);

      // 409 here where the step-up call answers 401: the same fact, answered by what the
      // endpoint was asked to do - see `AuthService.toPinRejection`.
      expect(String(response.body.message)).toMatch(/current pin is not correct/i);
      expect(String(response.body.message)).toMatch(
        new RegExp(`${PIN_MAX_ATTEMPTS - 1} attempts remaining`),
      );
      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(1);

      // The change was refused, so neither PIN is the new one: the digits that were in force
      // before still are, which is the property that makes this a check rather than a race.
      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: '5678' })
        .expect(401);

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(200);
    });

    it('refuses a currentPin of the wrong shape at the door, without counting an attempt', async () => {
      const account = await registerAndVerify(PIN);

      await request(app.getHttpServer())
        .post(PIN_CHANGE_PATH)
        .set(as(account))
        .send({ pin: '5678', currentPin: '12' })
        .expect(400);

      expect((await pinRow(account.userId)).transactionPinAttempts).toBe(0);
    });

    it('sets a PIN without currentPin on an account that has none (the SSO case)', async () => {
      const account = await registerAndVerify(PIN);

      await forgetPin(account.userId);

      const changed = await request(app.getHttpServer())
        .post(PIN_CHANGE_PATH)
        .set(as(account))
        .send({ pin: '4321' })
        .expect(200);

      expect(Number.isNaN(Date.parse(changed.body.pinSetAt as string))).toBe(false);
      expect((await pinRow(account.userId)).transactionPinLockedUntil).toBeNull();

      await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: '4321' })
        .expect(200);

      const sets = (await auditRows(account.userId)).filter(
        (row) => row.action === 'auth.pin.set',
      );

      // Two writers for one action, told apart by `metadata.source`: registration
      // (`registration`) and this call (`set`) - Step 34d's SSO account arrives here.
      expect(sets).toHaveLength(2);
      expect(sets[1]?.metadata).toMatchObject({ source: 'set' });
    });
  });

  describe('the step-up gate on POST /v1/payments', () => {
    /**
     * One payment attempt, carrying whatever the caller wants in the two credential headers.
     *
     * The body is valid and the idempotency key is fresh, so the only thing any of the tests
     * below varies is the second credential - which is the point: a 403 here can only be the
     * step-up guard, and it runs before anything reads the body or claims the key.
     */
    function attempt(account: Account, stepUp: string | undefined) {
      const sent = request(app.getHttpServer())
        .post(PAYMENTS_PATH)
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .set(as(account))
        .send({ recipientId: randomUUID(), amount: '1' });

      return stepUp === undefined ? sent : sent.set(STEP_UP_TOKEN_HEADER, stepUp);
    }

    it('refuses a payment with no step-up token, and records the refusal', async () => {
      const account = await registerAndVerify(PIN);

      const response = await attempt(account, undefined).expect(403);

      // 403 rather than 401: the access token was accepted and the caller *is* signed in.
      // What is missing is the second credential, which is what the message asks for.
      expect(String(response.body.message)).toMatch(/fresh pin confirmation/i);
      expect(String(response.body.message)).toContain(STEP_UP_TOKEN_HEADER);

      // The distinction the outcome exists for: this is a `denied` row, not a `failed` guess.
      // Nobody tried a PIN, and a row that said otherwise would make "someone is working
      // through the ten thousand PINs" and "someone tried to pay without their PIN" the
      // same finding. Newest last, so this is the row this request wrote - the ones before it
      // are the registration's.
      const rows = await auditRows(account.userId);

      expect(rows[rows.length - 1]).toMatchObject({
        action: 'auth.pin.failed',
        outcome: 'denied',
        metadata: { reason: 'missing' },
      });
    });

    it('refuses a token that is not ours, and one minted for another account', async () => {
      const account = await registerAndVerify(PIN);
      const other = await registerAndVerify(PIN);

      // Not a token at all: the same 403 as everything else here, because a message that
      // said *why* a forged token was refused tells whoever is forging them what to fix.
      await attempt(account, 'not-a-token').expect(403);

      const theirs = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(other))
        .send({ pin: PIN })
        .expect(200);

      // A real token, correctly signed and unexpired, minted for somebody else. This is the
      // failure the guard's subject comparison exists for: without it, anyone could create
      // an account, prove a PIN on it, and authorise payments from any other session.
      await attempt(account, theirs.body.stepUpToken as string).expect(403);

      const reasons = (await auditRows(account.userId))
        .filter((row) => row.outcome === 'denied')
        .map((row) => (row.metadata as { reason?: string }).reason);

      expect(reasons).toEqual(['invalid', 'other_account']);
    });

    it("refuses the caller's own access token, because the audience is what separates the two", async () => {
      const account = await registerAndVerify(PIN);

      // Both tokens are signed with one secret, so without a distinct audience this would be
      // a successful payment: `StepUpTokenService.verify` names `cashping-step-up`, and an
      // access token is not it.
      await attempt(account, account.accessToken).expect(403);

      // ...and the other direction of the same fact, which is the more serious one: the
      // step-up token is refused where a session is required, so it cannot stand in for an
      // access token on any other endpoint.
      const stepUp = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(200);

      await request(app.getHttpServer())
        .get(`/${GLOBAL_PREFIX}/auth/session`)
        .set('Authorization', `Bearer ${stepUp.body.stepUpToken as string}`)
        .expect(401);
    });

    it('refuses a step-up token whose five minutes have run out', async () => {
      const account = await registerAndVerify(PIN);

      /**
       * Signed by the same secret, for the same subject, with the same issuer and audience -
       * the only thing wrong with it is `exp`, a minute in the past. Waiting five minutes is
       * not an option, so the token is minted here from the app's own configuration; the 403
       * can then only be the lifetime, which is the assertion `verifyAsync` makes.
       */
      const jwt = new JwtService({
        secret: app.get(ConfigService).getOrThrow<string>('auth.jwtSecret'),
      });
      const expired = jwt.sign(
        { sub: account.userId },
        {
          expiresIn: -SECONDS_PER_MINUTE,
          algorithm: STEP_UP_TOKEN_ALGORITHM,
          issuer: STEP_UP_TOKEN_ISSUER,
          audience: STEP_UP_TOKEN_AUDIENCE,
        },
      );

      await attempt(account, expired).expect(403);

      const rows = await auditRows(account.userId);

      expect(rows[rows.length - 1]?.metadata).toMatchObject({ reason: 'invalid' });
    });

    it('lets a request carrying a fresh token past the guard', async () => {
      const account = await registerAndVerify(PIN);

      const stepUp = await request(app.getHttpServer())
        .post(PIN_VERIFY_PATH)
        .set(as(account))
        .send({ pin: PIN })
        .expect(200);

      /**
       * A refused *body* rather than a created payment, and the 400 is the proof: the guard
       * opened the door, the interceptor then read the key, and the validation pipe refused
       * an undeclared field. This file has no funded wallet and no substituted Horizon (see
       * the docstring), so the payment itself is asserted in `payments.e2e-spec.ts`, where
       * every request now carries this header - including the tests that assert it is
       * written as `PENDING`.
       */
      const response = await request(app.getHttpServer())
        .post(PAYMENTS_PATH)
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .set(as(account))
        .set(STEP_UP_TOKEN_HEADER, stepUp.body.stepUpToken as string)
        .send({ total: '1' })
        .expect(400);

      expect(String(response.body.message)).toMatch(/total/);
    });
  });
});







