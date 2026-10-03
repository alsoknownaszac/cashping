import { randomInt } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';

/**
 * Step 34b, over real HTTP: the password as a second way *in*.
 *
 * The claims this file makes are the ones the checklist names:
 *
 * 1. **A password can be set, changed and recovered.** Set through `POST /auth/password/change`
 *    (and proven at `POST /auth/login/password`), changed only by proving the current one, and
 *    recovered by SMS through the reset pair.
 * 2. **A wrong password is the same 401 as an unknown number.** The endpoint must not become an
 *    oracle, so both are asserted to answer with the *same* message.
 * 3. **The reset request answers identically for a known and an unknown number.** Both 202, same
 *    body - proven by calling it for both and comparing, and by checking that the SMS only
 *    actually goes to the registered one.
 *
 * Local-only, and it needs the compose stack (`docker compose up -d postgres redis`) plus a
 * `.env`, because it boots the real `AppModule`. Two providers are replaced, exactly as in
 * `pin.e2e-spec.ts`: the SMS sender, so codes are read from the captured message, and wallet
 * provisioning, so a verify reaches no KMS and no Horizon. Run it with `npm run test:e2e`.
 */

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const OTP_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
const LOGIN_PASSWORD_PATH = `/${GLOBAL_PREFIX}/auth/login/password`;
const PASSWORD_CHANGE_PATH = `/${GLOBAL_PREFIX}/auth/password/change`;
const PASSWORD_RESET_PATH = `/${GLOBAL_PREFIX}/auth/password/reset`;
const PASSWORD_RESET_CONFIRM_PATH = `/${GLOBAL_PREFIX}/auth/password/reset/confirm`;

/** The PIN registration insists on (Step 34a); the password tests never use it. */
const PIN = '1234';
/** A password that satisfies the minimum, and one that does not. */
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different password';
const TOO_SHORT = 'short';

/** Captures what would have been texted, so a code is readable without a phone. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  latestCodeFor(phoneNumber: string): string | undefined {
    const messages = this.sent.filter((message) => message.to === phoneNumber);
    const message = messages[messages.length - 1];

    if (message === undefined) {
      return undefined;
    }

    const matches = message.body.match(/\d{6}/g) ?? [];

    expect(matches).toHaveLength(1);

    return matches[0];
  }

  countFor(phoneNumber: string): number {
    return this.sent.filter((message) => message.to === phoneNumber).length;
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

/** One account this file created, and the credentials its tests need. */
interface Account {
  userId: string;
  accessToken: string;
  /** The E.164 form, which is what the cleanup deletes by. */
  phoneNumber: string;
}

describe('Password sign-in, change and reset (e2e)', () => {
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
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    const { count } = await prisma.user.deleteMany({ where: { phoneNumber: { in: registered } } });

    expect(count, 'every number this run created should have been removed').toBe(registered.length);

    await app.close();
  }, 60_000);

  /** Registers a number with a PIN and verifies it, the way a real first session is created. */
  async function registerAndVerify(): Promise<Account> {
    const local = freshLocalNumber();
    const e164 = toE164(local);

    registered.push(e164);

    await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local })
      .expect(201);

    const code = smsSender.latestCodeFor(e164);

    if (code === undefined) {
      throw new Error(`no verification code was texted to ${e164}`);
    }

    const verified = await request(app.getHttpServer())
      .post(OTP_VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(200);

    return {
      userId: verified.body.userId as string,
      accessToken: verified.body.accessToken as string,
      phoneNumber: e164,
    };
  }

  /** The bearer header the password-change route needs. */
  function as(account: Account): { authorization: string } {
    return { authorization: `Bearer ${account.accessToken}` };
  }

  /** The password column, read straight out of the row the API wrote. */
  function passwordRow(userId: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
  }

  describe('POST /v1/auth/password/change', () => {
    it('sets a password when there is none, and the account can then sign in with it', async () => {
      const account = await registerAndVerify();

      const set = await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: PASSWORD })
        .expect(200);

      expect(Number.isNaN(Date.parse(set.body.passwordSetAt as string))).toBe(false);

      // The row holds a scrypt hash carrying the *password* work factor, not the PIN's, and not
      // the password itself.
      const row = await passwordRow(account.userId);

      expect(row.passwordHash).toMatch(/^scrypt\$32768\$/);
      expect(row.passwordHash).not.toContain(PASSWORD);

      const signedIn = await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: PASSWORD })
        .expect(200);

      expect(signedIn.body.userId).toBe(account.userId);
      expect(signedIn.body.accessToken as string).toMatch(/^ey/);
    });

    it('refuses a change with no currentPassword once one is set, and leaves the password in force', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: PASSWORD })
        .expect(200);

      const before = (await passwordRow(account.userId)).passwordHash;

      const refused = await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: NEW_PASSWORD })
        .expect(409);

      expect(String(refused.body.message)).toMatch(/already has a password/i);
      // Nothing was written: a failed change leaves the old hash exactly as it was.
      expect((await passwordRow(account.userId)).passwordHash).toBe(before);
    });

    it('refuses a password below the minimum at the door, and writes nothing', async () => {
      const account = await registerAndVerify();

      const refused = await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: TOO_SHORT })
        .expect(400);

      expect(String(refused.body.message)).toMatch(/password/i);
      expect((await passwordRow(account.userId)).passwordHash).toBeNull();
    });

    it('replaces the password when the current one is proved, and the old one stops working', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: NEW_PASSWORD, currentPassword: PASSWORD })
        .expect(200);

      // The old password is refused, the new one works.
      await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: PASSWORD })
        .expect(401);

      await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: NEW_PASSWORD })
        .expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { userId: account.userId },
        select: { action: true, metadata: true },
      });
      const actions = rows.map((row) => row.action);

      expect(actions).toContain('auth.password.set');
      expect(actions).toContain('auth.password.changed');
      expect(actions).toContain('auth.password.login');
      // Neither password, nor either hash, is anywhere in what this run wrote for the account.
      expect(JSON.stringify(rows)).not.toContain(PASSWORD);
      expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(rows)).not.toContain('scrypt');
    });
  });

  describe('POST /v1/auth/login/password', () => {
    it('answers a wrong password exactly as it answers a number with no account', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: PASSWORD })
        .expect(200);

      const wrongPassword = await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: 'not the password' })
        .expect(401);

      // A number nothing registered: same route, same shape, and it must produce the same answer.
      const unknown = await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: freshLocalNumber(), password: 'not the password' })
        .expect(401);

      // One message for both is the whole point: an endpoint that distinguished them would tell
      // an attacker which numbers are registered.
      expect(unknown.body.message).toBe(wrongPassword.body.message);
      expect(String(wrongPassword.body.message)).toMatch(/do not match/i);
    });

    it('records a refused sign-in as denied and an accepted one as ok', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_CHANGE_PATH)
        .set(as(account))
        .send({ password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: 'wrong password' })
        .expect(401);

      await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: PASSWORD })
        .expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { userId: account.userId, action: 'auth.password.login' },
        orderBy: { createdAt: 'asc' },
        select: { outcome: true },
      });

      // `denied` for the refusal is Step 34a's outcome doing the job it was added for, and it is
      // what keeps `auth.login` meaning "a *code* sign-in succeeded".
      expect(rows.map((row) => row.outcome)).toEqual(['denied', 'ok']);
    });
  });

  describe('password reset', () => {
    it('answers 202 identically for a known and an unknown number, and texts only the known one', async () => {
      const account = await registerAndVerify();
      const before = smsSender.countFor(account.phoneNumber);

      const known = await request(app.getHttpServer())
        .post(PASSWORD_RESET_PATH)
        .send({ phoneNumber: account.phoneNumber })
        .expect(202);

      const unknownNumber = freshLocalNumber();
      const unknown = await request(app.getHttpServer())
        .post(PASSWORD_RESET_PATH)
        .send({ phoneNumber: unknownNumber })
        .expect(202);

      // The bodies are indistinguishable: same keys, same code length, both a future ISO expiry.
      // A response that differed would be an existence oracle.
      expect(Object.keys(known.body as object).sort()).toEqual(
        Object.keys(unknown.body as object).sort(),
      );
      expect(known.body.codeLength).toBe(unknown.body.codeLength);
      expect(Number.isNaN(Date.parse(unknown.body.expiresAt as string))).toBe(false);

      // ...and the honest difference is invisible from the response: a code went to the real
      // account, and to nobody at all for the number that does not exist.
      expect(smsSender.countFor(account.phoneNumber)).toBe(before + 1);
      expect(smsSender.countFor(toE164(unknownNumber))).toBe(0);
    });

    it('resets the password with the texted code, and the new password signs in', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_RESET_PATH)
        .send({ phoneNumber: account.phoneNumber })
        .expect(202);

      const code = smsSender.latestCodeFor(account.phoneNumber);

      if (code === undefined) {
        throw new Error('no reset code was texted');
      }

      await request(app.getHttpServer())
        .post(PASSWORD_RESET_CONFIRM_PATH)
        .send({ phoneNumber: account.phoneNumber, code, newPassword: NEW_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post(LOGIN_PASSWORD_PATH)
        .send({ phoneNumber: account.phoneNumber, password: NEW_PASSWORD })
        .expect(200);

      const actions = (
        await prisma.auditLog.findMany({
          where: { userId: account.userId },
          select: { action: true },
        })
      ).map((row) => row.action);

      expect(actions).toContain('auth.password.reset.requested');
      expect(actions).toContain('auth.password.reset.completed');
      expect(actions).toContain('auth.password.changed');
    });

    it('refuses a reset with a bad code, and the password is unchanged', async () => {
      const account = await registerAndVerify();

      await request(app.getHttpServer())
        .post(PASSWORD_RESET_PATH)
        .send({ phoneNumber: account.phoneNumber })
        .expect(202);

      const wrong = '000000';

      // Guard: the wrong code really is wrong, or the assertion below proves nothing.
      expect(smsSender.latestCodeFor(account.phoneNumber)).not.toBe(wrong);

      await request(app.getHttpServer())
        .post(PASSWORD_RESET_CONFIRM_PATH)
        .send({ phoneNumber: account.phoneNumber, code: wrong, newPassword: NEW_PASSWORD })
        .expect(400);

      expect((await passwordRow(account.userId)).passwordHash).toBeNull();
    });
  });
});

