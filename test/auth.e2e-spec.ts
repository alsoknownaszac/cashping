import { randomInt } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import { UserStatus } from './../src/generated/prisma/enums.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

/**
 * The Day 1 exit criterion, over real HTTP against a real database and Redis:
 * register a number, receive a code, verify it, and end up with an ACTIVE user.
 *
 * Local-only, and it needs the compose stack (`docker compose up -d postgres
 * redis`) plus a `.env` - the container ports are the ones `DATABASE_URL` and
 * `REDIS_URL` point at. Run it with `npm run test:e2e`, which is deliberately not
 * part of the CI job (no database service is provisioned there).
 *
 * The SMS sender is replaced, so the code is read from the captured message
 * instead of a phone, and Africa's Talking is never called from a test. Every
 * other participant is the production one: the global validation pipe, the
 * exception filter, Prisma, Redis and the OTP policy.
 */

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;

/** The policy this file relies on, mirroring `configuration()`. */
const REQUESTS_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;
const CODE_LENGTH = 6;

/** Captures what would have been texted, so the code is readable in the test. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  /** The messages addressed to one number, oldest first. */
  for(phoneNumber: string): SmsMessage[] {
    return this.sent.filter((message) => message.to === phoneNumber);
  }
}

const smsSender = new CapturingSmsSender();

/**
 * A Ghanaian mobile that has never been registered before.
 *
 * Random because the two things that make this flow interesting - the per-number
 * send allowance in Redis and the unique index on `phone_number` - both outlive a
 * run, so a fixed number would make the second run fail for the wrong reason.
 */
function uniqueLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7).toString().padStart(7, '0')}`;
}

/**
 * Every number this run registered, in the E.164 form the database stores, so
 * `afterAll` can remove exactly what this file created.
 */
const registered: string[] = [];

/** `+233241234567` from `0241234567`, asserted without the normalizer's help. */
function toE164(localNumber: string): string {
  const withoutTrunkPrefix = localNumber.replace(/^0/, '');

  expect(withoutTrunkPrefix).toMatch(/^2\d{8}$/);

  return `+233${withoutTrunkPrefix}`;
}

/**
 * A number that has never been registered, in both forms, recorded for cleanup.
 *
 * `registered` holds the *stored* E.164 form, because that is the column the
 * cleanup deletes by - recording the local form silently deletes nothing and
 * leaves the unique index populated for the next run.
 */
function freshNumber(): { local: string; e164: string } {
  const local = uniqueLocalNumber();
  const e164 = toE164(local);

  registered.push(e164);

  return { local, e164 };
}

/** Groups a local number the way a user might type it: `024 123 4567`. */
function toSpaced(localNumber: string): string {
  return `${localNumber.slice(0, 3)} ${localNumber.slice(3, 6)} ${localNumber.slice(6)}`;
}

/** The single code in an SMS body. */
function codeFrom(body: string): string {
  const matches = body.match(/\d{6}/g) ?? [];

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

/** A six-digit code that is not the issued one. */
function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

/** The newest code texted to `phoneNumber`, failing if there is none. */
function latestCodeFor(phoneNumber: string): string {
  const messages = smsSender.for(phoneNumber);
  const message = messages[messages.length - 1];

  if (message === undefined) {
    throw new Error(`no SMS was captured for ${phoneNumber}`);
  }

  return codeFrom(message.body);
}

describe('Registration and OTP verification (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, in the same order: without the prefix the
    // paths below would 404, and without the pipe a malformed body would reach the
    // service instead of being refused at the door.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Leftovers would make the *next* run fail: the unique index on `phone_number`
    // turns a repeated registration into a 409, and the Redis counters would still
    // hold the send allowance. The OTP rows go with the users (`onDelete: Cascade`).
    const { count } = await prisma.user.deleteMany({ where: { phoneNumber: { in: registered } } });

    expect(count, 'every number this run created should have been removed').toBe(registered.length);

    await app.close();
  });

  it('registers a number, normalizes it and texts a single code', async () => {
    const { local, e164 } = freshNumber();

    const response = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      // Local format, spaced: exactly how someone types it into a signup form.
      .send({ phoneNumber: toSpaced(local) })
      .expect(201);

    expect(response.body).toMatchObject({
      phoneNumber: e164,
      status: UserStatus.PENDING_VERIFICATION,
      codeLength: CODE_LENGTH,
    });
    expect(new Date(response.body.expiresAt as string).toISOString()).toBe(response.body.expiresAt);
    // The code never leaves the API in the body.
    expect(response.body).not.toHaveProperty('code');

    const user = await prisma.user.findUnique({ where: { phoneNumber: e164 } });

    expect(user?.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(user?.phoneVerifiedAt).toBeNull();

    const otp = await prisma.otpVerification.findFirst({
      where: { userId: user?.id as string },
    });

    // The row the whole step exists to protect: a hash, not the code.
    expect(otp?.codeHash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(otp?.consumedAt).toBeNull();
    expect(otp?.attempts).toBe(0);
    expect(otp?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const code = latestCodeFor(e164);

    expect(otp?.codeHash).not.toBe(code);
    expect(Object.values(otp ?? {})).not.toContain(code);
  });

  it('verifies the code, activating the user and consuming the code', async () => {
    const { local, e164 } = freshNumber();

    const registration = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ phoneNumber: local })
      .expect(201);

    const code = latestCodeFor(e164);

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      // The spaced form again: normalization has to hold on this path too, or a
      // user who types their number differently than they registered it is told
      // they have no account.
      .send({ phoneNumber: toSpaced(local), code })
      .expect(200);

    expect(response.body).toMatchObject({
      userId: registration.body.userId,
      phoneNumber: e164,
      status: UserStatus.ACTIVE,
    });
    expect(new Date(response.body.phoneVerifiedAt as string).toISOString()).toBe(
      response.body.phoneVerifiedAt,
    );

    const user = await prisma.user.findUnique({ where: { phoneNumber: e164 } });

    expect(user?.status).toBe(UserStatus.ACTIVE);
    // The Day 2 hand-off: set by the same write that activated the account.
    expect(user?.phoneVerifiedAt?.toISOString()).toBe(response.body.phoneVerifiedAt);

    const live = await prisma.otpVerification.count({
      where: { userId: user?.id as string, consumedAt: null },
    });

    expect(live).toBe(0);
  });

  it('refuses to verify an already active number with a 409', async () => {
    const { local, e164 } = freshNumber();

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);
    const code = latestCodeFor(e164);

    await request(app.getHttpServer()).post(VERIFY_PATH).send({ phoneNumber: local, code }).expect(200);

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(409);

    expect(response.body.message).toContain('already verified');
  });

  it('answers 404 for a number that never registered, creating nothing', async () => {
    const local = uniqueLocalNumber();

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: '123456' })
      .expect(404);

    expect(response.body.message).toContain('No registration found');
    expect(await prisma.user.count({ where: { phoneNumber: toE164(local) } })).toBe(0);
  });

  it('counts wrong guesses, then locks the code on the attempt that uses them up', async () => {
    const { local, e164 } = freshNumber();

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);
    const code = latestCodeFor(e164);
    const wrong = wrongCode(code);

    const user = await prisma.user.findUnique({ where: { phoneNumber: e164 } });
    const userId = user?.id as string;

    // Every attempt but the last is answered with how many guesses are left.
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post(VERIFY_PATH)
        .send({ phoneNumber: local, code: wrong })
        .expect(400);

      expect(response.body.message).toContain(`${MAX_ATTEMPTS - attempt} attempts remaining`);
    }

    const counted = await prisma.otpVerification.findFirst({ where: { userId } });

    expect(counted?.attempts).toBe(MAX_ATTEMPTS - 1);
    expect(counted?.consumedAt).toBeNull();

    // The attempt that uses up the allowance is a 429, and it kills the code.
    const locked = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: wrong })
      .expect(429);

    expect(locked.body.message).toContain('Too many incorrect attempts');

    // Even the correct code is refused afterwards, because there is no live code.
    const tooLate = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(400);

    expect(tooLate.body.message).toContain('No verification code is outstanding');

    const spent = await prisma.otpVerification.findFirst({ where: { userId } });

    expect(spent?.consumedAt).not.toBeNull();
  });

  it('refuses an expired code and consumes it', async () => {
    const { local, e164 } = freshNumber();

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);
    const code = latestCodeFor(e164);

    const user = await prisma.user.findUnique({ where: { phoneNumber: e164 } });
    const userId = user?.id as string;

    // Backdated rather than waited out: the same row the service reads, with the
    // expiry moved into the past.
    await prisma.otpVerification.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(400);

    expect(response.body.message).toContain('expired');

    const spent = await prisma.otpVerification.findFirst({ where: { userId } });

    expect(spent?.consumedAt).not.toBeNull();
    // Expiry is not a wrong guess, so it does not spend attempts.
    expect(spent?.attempts).toBe(0);
  });

  it('caps how many codes one number can request, and sends nothing for the blocked one', async () => {
    const { local, e164 } = freshNumber();

    // Three sends are the allowance, and each one replaces the previous code.
    for (let send = 0; send < REQUESTS_PER_WINDOW; send += 1) {
      await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);
    }

    expect(smsSender.for(e164)).toHaveLength(REQUESTS_PER_WINDOW);

    const blocked = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ phoneNumber: local })
      .expect(429);

    expect(blocked.body.message).toContain('Try again in 15 minutes');

    // Nothing was sent and nothing was written for the blocked request...
    expect(smsSender.for(e164)).toHaveLength(REQUESTS_PER_WINDOW);

    const user = await prisma.user.findUnique({ where: { phoneNumber: e164 } });
    const userId = user?.id as string;

    expect(await prisma.otpVerification.count({ where: { userId } })).toBe(REQUESTS_PER_WINDOW);
    // ...and the resends reused the one user row rather than creating more.
    expect(await prisma.user.count({ where: { phoneNumber: e164 } })).toBe(1);
    // One code is live, so the allowance bought three sends and one usable code.
    expect(await prisma.otpVerification.count({ where: { userId, consumedAt: null } })).toBe(1);
  });
});
