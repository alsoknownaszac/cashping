import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import {
  EMAIL_SENDER,
  type EmailMessage,
  type EmailSendResult,
  type EmailSender,
} from './../src/notifications/email/email-sender.js';
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
 * Step 34c, over real HTTP: an email address that has been *proved*, which is what a receipt needs.
 *
 * The claims this file makes are the ones the checklist names:
 *
 * 1. **An address is attached unverified, and the code that proves it is emailed.** Both halves are
 *    asserted, because they are two different facts: the row holds the address the moment it is
 *    accepted, and `email_verified_at` stays null until a code from that mailbox comes back.
 * 2. **Only a proved address is a delivery target.** The unit specs cover the split in isolation;
 *    what is proven here is the whole path, from `EMAIL_SENDER` under test to the row.
 * 3. **The refusals are the ones a client can act on.** A wrong code, an expired one, one that has
 *    been used, a spent allowance, an address another account holds, and confirming when nothing is
 *    attached - each provoked rather than asserted about.
 *
 * Local-only, and it needs the compose stack (`docker compose up -d postgres redis`) plus a `.env`,
 * because it boots the real `AppModule`. Three providers are replaced, exactly as in
 * `password.e2e-spec.ts`: the SMS sender (registration needs a code out of a text), wallet
 * provisioning (so verifying reaches no KMS and no Horizon), and the email sender - which is the
 * seam this step exists for, and the only way the code is readable without a mailbox.
 *
 * Run it with `npm run test:e2e`.
 */

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const OTP_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
const EMAIL_PATH = `/${GLOBAL_PREFIX}/auth/email`;
const EMAIL_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/email/verify`;

/** The PIN registration insists on (Step 34a); this file never uses it. */
const PIN = '1234';
/** The OTP policy configuration() supplies, mirrored here rather than hard-coded per assertion. */
const OTP_MAX_ATTEMPTS = 5;

/** Captures what would have been texted, so the registration code is readable without a phone. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  latestCodeFor(phoneNumber: string): string {
    const body = this.latestBodyFor((message) => message.to === phoneNumber);
    const matches = body.match(/\d{6}/g) ?? [];

    expect(matches).toHaveLength(1);

    return matches[0] as string;
  }

  private latestBodyFor(predicate: (message: SmsMessage) => boolean): string {
    const messages = this.sent.filter(predicate);
    const message = messages[messages.length - 1];

    if (message === undefined) {
      throw new Error('no SMS was captured');
    }

    return message.body;
  }
}

/**
 * The substituted `EMAIL_SENDER` - the seam Step 34c introduces, and the only place a verification
 * code can be read from in a test, because the response deliberately does not echo it.
 *
 * The whole `EmailMessage` is kept rather than only the body: the assertions below are as much about
 * *where* a message went and who it was from as about what it said.
 */
class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-email-${this.sent.length}` };
  }

  /** Every message addressed to one address, newest last. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  latestCodeFor(address: string): string {
    const messages = this.to(address);
    const message = messages[messages.length - 1];

    if (message === undefined) {
      throw new Error(`no email was captured for ${address}`);
    }

    const matches = message.body.match(/\d{6}/g) ?? [];

    expect(matches).toHaveLength(1);

    return matches[0] as string;
  }
}

const smsSender = new CapturingSmsSender();
const emailSender = new CapturingEmailSender();

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

/**
 * A unique address per test.
 *
 * `users.email` is unique, so a fixture address left behind by an earlier run would turn the first
 * attach of this one into a 409 with nothing to do with this file. A `randomUUID` local part cannot
 * collide, and the domain is one nobody can receive at - which matters because the sender is
 * substituted and nothing is ever actually mailed.
 */
function freshAddress(): string {
  return `e2e-${randomUUID()}@cashping.test`;
}

/** One account this file created, and the credentials its tests need. */
interface Account {
  userId: string;
  accessToken: string;
  /** The E.164 form, which is what the SMS assertions and the cleanup use. */
  phoneNumber: string;
}

describe('Email attach and verify (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** Every number this run registered, so `afterAll` removes exactly what it created. */
  const registered: string[] = [];
  /** Every address this run attached, so the cleanup also takes accounts created by a dead run. */
  const addresses: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      // Step 34c's seam. The default binding refuses to send, so without this the attach below would
      // be a 503 - which is itself the sign the seam is real rather than a shortcut in the service.
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
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
    // By address as well as by number: an account whose attach succeeded but whose test failed
    // mid-flight would otherwise hold a unique address this run picked, and the next run cannot pick
    // it anyway (the local part is random) - but the *account* still deserves to go.
    const { count } = await prisma.user.deleteMany({
      where: { OR: [{ phoneNumber: { in: registered } }, { email: { in: addresses } }] },
    });

    expect(count, 'every account this run created should have been removed').toBe(
      registered.length,
    );

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

  /** The bearer header every route in this file needs. */
  function as(account: Account): { authorization: string } {
    return { authorization: `Bearer ${account.accessToken}` };
  }

  /** Attaches an address and returns it, with the code the email carried. */
  async function attach(
    account: Account,
    address = freshAddress(),
  ): Promise<{ address: string; code: string }> {
    addresses.push(address);

    await request(app.getHttpServer())
      .post(EMAIL_PATH)
      .set(as(account))
      .send({ email: address })
      .expect(200);

    return { address, code: emailSender.latestCodeFor(address) };
  }

  /** The two columns the whole step is about, read straight out of the row the API wrote. */
  function emailRow(userId: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
  }

  /** The same digits with the first one changed: a code that is wrong, but well-formed. */
  function flipFirstDigit(code: string): string {
    return `${code.charAt(0) === '0' ? '1' : '0'}${code.slice(1)}`;
  }

  describe('POST /v1/auth/email', () => {
    it('attaches the address lower-cased and unverified, and emails the code to it', async () => {
      const account = await registerAndVerify();
      const address = freshAddress();

      addresses.push(address);

      // Submitted the way a keyboard does it, not the way the column wants it: the assertion below
      // is on the *stored* value, which is what makes normalization observable from outside.
      const submitted = `  ${address.toUpperCase()}  `;

      const response = await request(app.getHttpServer())
        .post(EMAIL_PATH)
        .set(as(account))
        .send({ email: submitted })
        .expect(200);

      expect(response.body.email).toBe(address);
      expect(response.body.codeLength).toBe(6);

      const expiresAt = new Date(response.body.expiresAt as string);

      expect(Number.isNaN(expiresAt.getTime())).toBe(false);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      // The row says what the checklist says: attached, and nothing has proved it yet.
      const row = await emailRow(account.userId);

      expect(row.email).toBe(address);
      expect(row.emailVerifiedAt).toBeNull();

      // And the code went out over the email seam - one message, to that address, from the sender
      // this deployment is configured with. The address is the *only* route to the code, which is why
      // this is the assertion the whole file is built around.
      const messages = emailSender.to(address);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.from).toBe(app.get(ConfigService).getOrThrow<string>('email.from'));
      expect(messages[0]?.subject).toMatch(/verification code/i);

      const code = emailSender.latestCodeFor(address);

      expect(messages[0]?.body).toContain(code);
      // Never in the response: an echoed code would be a code anyone who can read one log line has.
      expect(JSON.stringify(response.body)).not.toContain(code);

      // The attach is audited (Step 32's vocabulary), and the row names the account rather than the
      // address: an audit log is one more place an identifier must not appear in the clear.
      const auditRows = await prisma.auditLog.findMany({
        where: { userId: account.userId, action: 'auth.email.set' },
      });

      expect(auditRows).toHaveLength(1);
      expect(JSON.stringify(auditRows)).not.toContain(address);
    }, 60_000);

    it('refuses an address another account already holds, and writes nothing', async () => {
      const holder = await registerAndVerify();
      const other = await registerAndVerify();

      const { address } = await attach(holder);

      const refused = await request(app.getHttpServer())
        .post(EMAIL_PATH)
        .set(as(other))
        .send({ email: address })
        .expect(409);

      expect(refused.body.message).toMatch(/already in use/i);

      // The whole point of the refusal: the second account is untouched and no second code was
      // mailed to a mailbox that is not its own.
      expect((await emailRow(other.userId)).email).toBeNull();
      expect(emailSender.to(address)).toHaveLength(1);
    }, 60_000);

    it('refuses an address that is not one, echoing what was sent', async () => {
      const account = await registerAndVerify();

      const refused = await request(app.getHttpServer())
        .post(EMAIL_PATH)
        .set(as(account))
        .send({ email: 'not-an-address' })
        .expect(400);

      // The message names the value, not just "invalid email": the user has to be able to see the
      // typo. `normalizeEmailAddress` is the one place that decides, and this is its output.
      expect(refused.body.message).toBe('"not-an-address" is not a valid email address.');
      expect((await emailRow(account.userId)).email).toBeNull();
      // The shape rule runs before any write, so no code was generated for a string that is not an
      // address - there was nothing to send to.
      expect(emailSender.to('not-an-address')).toHaveLength(0);
    }, 60_000);
  });

  describe('POST /v1/auth/email/verify', () => {
    it('confirms the attached address with the code the email carried', async () => {
      const account = await registerAndVerify();

      const { address, code } = await attach(account);

      const confirmed = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code })
        .expect(200);

      expect(confirmed.body.email).toBe(address);

      const verifiedAt = new Date(confirmed.body.emailVerifiedAt as string);

      expect(Number.isNaN(verifiedAt.getTime())).toBe(false);
      // "Now", not "some time in the past": the answer and the column are the same instant.
      expect(Date.now() - verifiedAt.getTime()).toBeLessThan(60_000);
      expect(Date.now() - verifiedAt.getTime()).toBeGreaterThanOrEqual(0);

      // The column a receipt is conditioned on is filled, for the address that was attached.
      const row = await emailRow(account.userId);

      expect(row.email).toBe(address);
      expect(Math.abs((row.emailVerifiedAt as Date).getTime() - verifiedAt.getTime())).toBeLessThan(
        1_000,
      );

      // Confirming is audited separately from attaching: two facts, and the second is the one that
      // makes the address a delivery target. The address is still absent from the row.
      const auditRows = await prisma.auditLog.findMany({
        where: { userId: account.userId, action: 'auth.email.verified' },
      });

      expect(auditRows).toHaveLength(1);
      expect(JSON.stringify(auditRows)).not.toContain(address);
    }, 60_000);

    it('refuses a wrong code, leaving the address attached and unverified', async () => {
      const account = await registerAndVerify();

      const { address, code } = await attach(account);

      const refused = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code: flipFirstDigit(code) })
        .expect(400);

      // The message counts down what is left, which is the part a user acts on.
      expect(refused.body.message).toContain(`${OTP_MAX_ATTEMPTS - 1} attempts remaining`);

      const row = await emailRow(account.userId);

      // A wrong code costs an attempt, not the address - and it certainly verifies nothing.
      expect(row.email).toBe(address);
      expect(row.emailVerifiedAt).toBeNull();
    }, 60_000);

    it('refuses an expired code, and spends it so it cannot be tried again', async () => {
      const account = await registerAndVerify();

      const { code } = await attach(account);

      // Aged past its lifetime the way time would: the rules under test are the OTP service's, and
      // waiting out a real TTL is not a test.
      const aged = await prisma.otpVerification.updateMany({
        where: { userId: account.userId, consumedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      expect(aged.count).toBe(1);

      const refused = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code })
        .expect(400);

      expect(refused.body.message).toMatch(/expired/i);
      expect((await emailRow(account.userId)).emailVerifiedAt).toBeNull();

      // A dead code is consumed by the check that found it dead, so it cannot be presented again and
      // cannot become the row a later allowance is counted against.
      expect(
        await prisma.otpVerification.count({
          where: { userId: account.userId, consumedAt: null },
        }),
      ).toBe(0);
    }, 60_000);

    it('refuses a second confirmation of an address that is already verified', async () => {
      const account = await registerAndVerify();

      const { code } = await attach(account);

      await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code })
        .expect(200);

      // With the very code that worked: the account-shaped refusal is answered before the code is
      // looked at, because "this is already done" is the useful thing to say, not "that code is
      // spent".
      const refused = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code })
        .expect(409);

      expect(refused.body.message).toMatch(/already verified/i);
    }, 60_000);

    it('refuses to confirm when no address is attached at all', async () => {
      const account = await registerAndVerify();

      const refused = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code: '000000' })
        .expect(409);

      // 409 rather than 400: nothing is wrong with the code, the account simply has no address to
      // prove - and the message says which call to make instead.
      expect(refused.body.message).toMatch(/No email address is attached/i);
      expect((await emailRow(account.userId)).email).toBeNull();
    }, 60_000);

    it('stops accepting guesses once the allowance is spent, correct code included', async () => {
      const account = await registerAndVerify();

      const { code } = await attach(account);
      const wrong = flipFirstDigit(code);

      // Every attempt but the last is a 400 that says how many are left.
      for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        const refused = await request(app.getHttpServer())
          .post(EMAIL_VERIFY_PATH)
          .set(as(account))
          .send({ code: wrong })
          .expect(400);

        expect(refused.body.message).toContain(`${OTP_MAX_ATTEMPTS - attempt} attempts remaining`);
      }

      // The attempt that spends the allowance is a 429, and it consumes the code in the same write -
      // so the limit is "five wrong guesses", not "five, and then the right one".
      await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code: wrong })
        .expect(429);

      const refused = await request(app.getHttpServer())
        .post(EMAIL_VERIFY_PATH)
        .set(as(account))
        .send({ code })
        .expect(400);

      expect(refused.body.message).toMatch(/No verification code is outstanding/i);
      expect((await emailRow(account.userId)).emailVerifiedAt).toBeNull();
    }, 60_000);
  });
});
