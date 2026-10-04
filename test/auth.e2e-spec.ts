import { createHash, randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import { UserStatus } from './../src/generated/prisma/enums.js';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from './../src/identity/handle/handle.js';
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

/**
 * The Day 1 exit criterion, over real HTTP against a real database and Redis:
 * register a number, receive a code, verify it, and end up with an ACTIVE user.
 *
 * Step 16's endpoints live here too, because they are the other half of the same
 * flow: `login/otp`, `login`, `refresh`, `logout` and the guarded `session` are what
 * a verified user does next, and they share this file's app, database and captured
 * SMS sender rather than booting a second copy of all three.
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
 *
 * Step 19's wallet provisioning is the one other thing replaced, and for the same kind of
 * reason - see `RecordingProvisioning`. It sits *behind* a verification, so leaving it real
 * would make every verify in this file reach KMS, a faucet and Horizon to test something
 * else.
 */

const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;

/** The PIN every registration sends (Step 34a): exactly four digits, or the DTO refuses the body. */
const PIN = '1234';
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
const LOGIN_CODE_PATH = `/${GLOBAL_PREFIX}/auth/login/otp`;
const LOGIN_PATH = `/${GLOBAL_PREFIX}/auth/login`;
const REFRESH_PATH = `/${GLOBAL_PREFIX}/auth/refresh`;
const LOGOUT_PATH = `/${GLOBAL_PREFIX}/auth/logout`;
const SESSION_PATH = `/${GLOBAL_PREFIX}/auth/session`;

/** The policy this file relies on, mirroring `configuration()`. */
const REQUESTS_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;
const CODE_LENGTH = 6;

/** The session lifetimes this file relies on, mirroring `configuration()`. */
const ACCESS_TOKEN_TTL_MINUTES = 15;
const REFRESH_TOKEN_TTL_DAYS = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Seconds in a minute, for the one place a lifetime is expressed in seconds: a token
 * signed with a negative `expiresIn` (see the expiry test below), which is how a token
 * issued in the past is minted without waiting for one.
 */
const SECONDS_PER_MINUTE = 60;

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
 * `AccountProvisioningService`, replaced (Step 19).
 *
 * `verifyOtp` provisions a wallet, so the *real* flow reaches KMS, friendbot and Horizon
 * from behind an endpoint this file exercises in a dozen tests. Two reasons that cannot
 * stand: a run would fail for reasons that have nothing to do with registration and
 * sessions (a faucet that is down, an expired AWS session), and on a machine whose AWS
 * credentials work it would create real Testnet accounts - and `stellar_accounts` is
 * `ON DELETE RESTRICT`, so `afterAll` could no longer clean up after itself.
 *
 * What is left is the part this file is actually positioned to check: that verification
 * *asks* for the right user's wallet. Everything inside the wallet has its own offline spec
 * (`account-provisioning.service.spec.ts`). Step 19's live run - a real funded account with a
 * real USDC trustline on Testnet - is a separate, still-open item: nothing in this file should
 * be read as evidence that it has happened.
 */
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
 * A Ghanaian mobile that has never been registered before.
 *
 * Random because the two things that make this flow interesting - the per-number
 * send allowance in Redis and the unique index on `phone_number` - both outlive a
 * run, so a fixed number would make the second run fail for the wrong reason.
 */
function uniqueLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/**
 * How many numbers this run reserves.
 *
 * One per registration flow, and one for the never-registered case - so the pool is
 * deliberately roomy: a test added later should not have to remember to resize it, and
 * `takeReservedNumber` fails loudly if it does.
 */
const RESERVED_NUMBERS = 40;

/**
 * The handles this file claims as literals, in the canonical form the database stores.
 *
 * They are cleaned in `beforeAll` for the same reason the reserved numbers are: `handle`
 * is unique across the whole table, so a run that is interrupted between its two
 * registrations leaves the first one held, and the next run's *first* registration is a
 * 409 that has nothing to do with the code under test. Seen once, on 2026-09-29, from a
 * run killed mid-suite: `+233247381367` still holding `miriam`. Every other handle in
 * this file is derived from a number it drew, and is covered by the number cleanup.
 */
const CLAIMED_HANDLES = ['miriam', 'admiral'];

/**
 * The numbers this run may use, filled in `beforeAll` *before* the first one is handed
 * out, so that whatever a previous run left behind for them can be deleted first.
 *
 * Reserved up front rather than drawn on demand, because "this number has never been
 * registered" is a precondition a random draw does not actually give you: the database
 * is the compose one and it outlives the run, and a run that was interrupted - Ctrl-C,
 * a crash, a killed test process - never reaches the `afterAll` below that removes its
 * rows. The file already depends on having no leftovers (see that hook); this is the
 * other half of it, for the leftovers it cannot know about.
 */
let availableNumbers: string[] = [];

/** Takes the next reserved number, failing if the pool was sized too small. */
function takeReservedNumber(): string {
  const local = availableNumbers.shift();

  if (local === undefined) {
    throw new Error(
      `This file drew more than its ${RESERVED_NUMBERS} reserved numbers. Raise RESERVED_NUMBERS.`,
    );
  }

  return local;
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
  const local = takeReservedNumber();
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

/**
 * A statement the database *accepted*, thrown to roll its transaction back.
 *
 * The constraint test below wants to run an INSERT and leave nothing behind whichever
 * way it goes, so committing is not an option and a `DELETE` afterwards is not the same
 * thing: the row would exist for a moment, and a failure in between would leave it.
 * Throwing from inside `prisma.$transaction` rolls the whole thing back, and this
 * error's *identity* is what tells "the database accepted it" apart from "the database
 * refused it" - the distinction the assertions are built on.
 */
class RolledBackAfterSuccess extends Error {
  constructor(readonly handle: string) {
    super(`the database accepted handle "${handle}", so this transaction is rolled back`);
    this.name = 'RolledBackAfterSuccess';
  }
}

/**
 * Writes one handle into `users` with no normalizer in the way, then rolls it back.
 *
 * The INSERT names only the columns it needs: `id` and `updated_at` have no database
 * default (Prisma supplies both from the client on every ordinary write), and `status`
 * does have one, so omitting it is what a real row would get. Everything else is left
 * unset, so the only rule this statement can break is the one under test.
 */
async function attemptRawHandleInsert(
  prisma: PrismaService,
  e164: string,
  handle: string,
): Promise<RolledBackAfterSuccess | Error> {
  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO "users" ("id", "phone_number", "handle", "updated_at") VALUES ($1::uuid, $2, $3, CURRENT_TIMESTAMP)',
        randomUUID(),
        e164,
        handle,
      );

      throw new RolledBackAfterSuccess(handle);
    })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
}

/** The half of a session response this file compares between requests. */
interface SessionBody {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshExpiresAt: string;
}

/** `refresh_tokens.token_hash`'s value for a token, computed here rather than trusted. */
function digestOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

/** `Authorization: Bearer <token>`, the only way this API accepts an access token. */
function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/** Registers a number and verifies it, returning the session verification handed back. */
async function registerAndVerify(
  app: INestApplication<App>,
  local: string,
  e164: string,
): Promise<SessionBody> {
  /**
   * Captured rather than `.expect(201)`, for a reason worth the extra lines: this
   * assertion has been seen to fail with a 401 - a status no registration route can
   * produce, since `POST /auth/register` carries no guard at all - on a machine whose
   * wall clock jumps and whose event loop freezes for minutes at a time. Whatever the
   * answer really was, the failure now carries it.
   */
  const registration = await request(app.getHttpServer())
    .post(REGISTER_PATH)
    .send({ pin: PIN, phoneNumber: local });

  expect(
    registration.status,
    `expected 201 from ${REGISTER_PATH} for a reserved number, got ${
      registration.status
    } ${JSON.stringify(registration.body)}`,
  ).toBe(201);

  const code = latestCodeFor(e164);

  const response = await request(app.getHttpServer())
    .post(VERIFY_PATH)
    .send({ phoneNumber: local, code })
    .expect(200);

  return {
    userId: response.body.userId as string,
    accessToken: response.body.accessToken as string,
    refreshToken: response.body.refreshToken as string,
    accessTokenExpiresAt: response.body.accessTokenExpiresAt as string,
    refreshExpiresAt: response.body.refreshExpiresAt as string,
  };
}

/**
 * Asks for a sign-in code and spends it, the way a second device signs in: the same
 * two calls the app makes, with the code read from the captured SMS.
 */
async function signInWithCode(
  app: INestApplication<App>,
  local: string,
  e164: string,
): Promise<SessionBody & { handle: string | null }> {
  await request(app.getHttpServer()).post(LOGIN_CODE_PATH).send({ phoneNumber: local }).expect(200);

  const code = latestCodeFor(e164);

  const response = await request(app.getHttpServer())
    .post(LOGIN_PATH)
    .send({ phoneNumber: local, code })
    .expect(200);

  return {
    userId: response.body.userId as string,
    accessToken: response.body.accessToken as string,
    refreshToken: response.body.refreshToken as string,
    accessTokenExpiresAt: response.body.accessTokenExpiresAt as string,
    refreshExpiresAt: response.body.refreshExpiresAt as string,
    handle: response.body.handle as string | null,
  };
}

describe('Registration, verification and sessions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      // Step 19: the wallet, out of the way of everything below - see
      // `RecordingProvisioning` for why, and for the one thing it still asserts.
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, in the same order: without the prefix the
    // paths below would 404, and without the pipe a malformed body would reach the
    // service instead of being refused at the door.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);

    /**
     * The numbers this run will use, drawn here so they can be checked for leftovers
     * before any test depends on them being unregistered. `deleteMany` rather than
     * `delete`, because having no row is the normal case; the point is that a number
     * left behind by an interrupted run cannot make a first registration a 409 or a
     * never-registered number something other than a 404.
     */
    availableNumbers = Array.from({ length: RESERVED_NUMBERS }, uniqueLocalNumber);

    await prisma.user.deleteMany({
      where: { phoneNumber: { in: availableNumbers.map(toE164) } },
    });

    /**
     * ...and the two fixed handles, which are not derived from a drawn number and so are
     * not covered by the delete above - see `CLAIMED_HANDLES`. Deleting by handle is safe
     * here in a way deleting by any looser criterion would not be: these are values this
     * file brings, so a row holding one was written by this suite, or by a run of it that
     * died before its own cleanup.
     */
    await prisma.user.deleteMany({ where: { handle: { in: CLAIMED_HANDLES } } });
  });

  /**
   * What a failed token assertion should report: the claims the token was sent with, and
   * the clock the API is judging them by.
   *
   * Added because a 401 was seen for a token this API had issued seconds earlier, in a run
   * whose own durations were normal - on a machine whose wall clock jumps: one run reported
   * a `Duration` of 17,516 seconds, six consecutive runs spanned 02:29:41 to 07:40:28, and
   * Prisma refused a commit with "873435 ms passed since the start of the transaction"
   * against its 5,000 ms timeout. A lifetime is `iat + 900`, so a jump is exactly how a
   * fresh token becomes an expired one; printing `exp` next to `now` is what tells the two
   * apart next time.
   */
  function tokenState(accessToken: string): string {
    const claims = app
      .get(JwtService, { strict: false })
      .decode<{ iat?: number; exp?: number }>(accessToken);

    return `claims=${JSON.stringify(claims)} now=${Math.floor(Date.now() / 1_000)}`;
  }

  afterAll(async () => {
    // Leftovers would make the *next* run fail: the unique index on `phone_number`
    // turns a repeated registration into a 409, and the Redis counters would still
    // hold the send allowance. The OTP rows go with the users (`onDelete: Cascade`).
    const { count } = await prisma.user.deleteMany({ where: { phoneNumber: { in: registered } } });

    expect(count, 'every number this run created should have been removed').toBe(registered.length);

    /**
     * ...and the counters have to go with them.
     *
     * The allowance is a fixed window keyed by the number (`otp:requests:<sha256>`,
     * see `OtpRateLimiterService`), so it outlives the rows that were just deleted:
     * without this, a number that hit the limit in one run starts the next run three
     * sends down and the failure looks like a bug in the limiter rather than a
     * leftover. The keys are derived exactly as the limiter derives them - the same
     * "asserted without the helper's help" trick `toE164` uses for the normalizer -
     * and deleting them by name rather than by pattern is deliberate: `KEYS
     * otp:requests:*` is the O(N) call the limiter's own comment avoids, and a
     * blanket `FLUSHDB` would wipe another suite's counters.
     */
    const counterKeys = registered.map(
      (phoneNumber) => `otp:requests:${createHash('sha256').update(phoneNumber).digest('hex')}`,
    );

    /**
     * Every one of these is deleted whether or not it exists, which is what makes
     * this safe to run after a test that failed before it ever sent a code.
     *
     * Guarded on a non-empty list, because "deletes whether or not it exists" is not
     * true of a *zero-key* `DEL`/`EXISTS`: Redis answers `ERR wrong number of arguments
     * for 'del' command`, which reported this hook as the failure and hid the hook that
     * had actually failed (`beforeAll` timing out, seen on a machine whose clock jumps).
     */
    if (counterKeys.length > 0) {
      const redis = app.get(RedisService).client;

      await redis.del(...counterKeys);

      expect(
        await redis.exists(...counterKeys),
        'the OTP request counters for this run should have been removed',
      ).toBe(0);
    }

    await app.close();
  });

  it('registers a number, normalizes it and texts a single code', async () => {
    const { local, e164 } = freshNumber();

    const response = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      // Local format, spaced: exactly how someone types it into a signup form.
      .send({ pin: PIN, phoneNumber: toSpaced(local) })
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

  /**
   * Step 15's audit item, at the altitude it names: `@Miriam` and `@miriam` are one
   * handle, and the *endpoint* is where that has to hold. The normalizer and the CHECK
   * constraint are covered on their own; neither of them is what a second signup talks
   * to, and the migration's comment used to say this file already proved the conflict
   * when it sent no handle at all.
   */
  it('refuses a handle another account already holds in a different case, with a 409', async () => {
    const first = freshNumber();
    // Drawn without `freshNumber()`, because this is the number that has to come out of
    // the test with *no* row: `registered` is what `afterAll` deletes and counts, and a
    // number recorded but never written would be reported as a row that went missing.
    const secondLocal = takeReservedNumber();
    const secondE164 = toE164(secondLocal);

    const claimed = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: first.local, handle: '@Miriam' })
      .expect(201);

    // The *canonical* form is what was stored, and it is what the answer reports. This
    // is the fact that makes the refusal below a case-insensitive conflict rather than
    // two different handles happening to collide.
    expect(claimed.body.handle).toBe('miriam');

    const conflict = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: secondLocal, handle: '@miriam' })
      .expect(409);

    expect(conflict.body.message).toContain('@miriam is already taken');

    // The handle still belongs to the first account, and the refused signup left no row
    // of its own behind - which is also why the second number is still unregistered.
    expect((await prisma.user.findUnique({ where: { phoneNumber: first.e164 } }))?.handle).toBe(
      'miriam',
    );
    expect(await prisma.user.findUnique({ where: { phoneNumber: secondE164 } })).toBeNull();
  });

  it('refuses a reserved handle over HTTP, and claims nothing for the number that tried', async () => {
    const { local, e164 } = freshNumber();

    const refused = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local, handle: '@admin' })
      .expect(400);

    expect(refused.body.message).toContain('"@admin" is reserved by Cashping');

    // The reserved set is consulted before the row is written (a refused handle costs no
    // SMS), so the number is still unregistered...
    expect(await prisma.user.findUnique({ where: { phoneNumber: e164 } })).toBeNull();

    // ...and that is what this second call proves rather than assumes: had the refused
    // attempt written a row, the number would now be taken and this would be a 409 for a
    // number nobody has claimed.
    const accepted = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local, handle: 'admiral' })
      .expect(201);

    expect(accepted.body.handle).toBe('admiral');
  });

  /**
   * The migration's own assertion, at the only altitude that can make it: a write that
   * never goes through `resolveHandle`/`assertHandleAllowed`. The endpoint above cannot
   * stand in for it - a handle the normalizer would reject never reaches the database -
   * and this is the constraint a future code path would have to be saved by, so it is
   * the constraint that has to be shown refusing something.
   */
  it('keeps a non-canonical handle out of the database even when the INSERT skips normalization', async () => {
    // Drawn without `freshNumber()` for the same reason as the number above: every INSERT
    // here is rolled back, so this number must not be counted as a row to delete -
    // `afterAll` would then report a row this file never left behind.
    const e164 = toE164(takeReservedNumber());

    // A canonical handle goes through the same statement, so what the cases below prove
    // is the CHECK refusing a value, not a malformed INSERT.
    expect(await attemptRawHandleInsert(prisma, e164, 'ok_handle')).toBeInstanceOf(
      RolledBackAfterSuccess,
    );

    for (const handle of ['Miriam', 'has-dash', 'ab', 'x'.repeat(HANDLE_MAX_LENGTH + 1)]) {
      const refused = await attemptRawHandleInsert(prisma, e164, handle);

      // The constraint by name, and the SQLSTATE that says it was a CHECK violation
      // rather than some other refusal (a type error, a unique index) wearing its message.
      expect(String(refused)).toContain('users_handle_canonical_form');
      expect(String(refused)).toContain('23514');
    }

    // The bounds in the constraint are literals ('^[a-z0-9_]{3,20}$') while the service
    // uses these constants, and nothing compares the two: move one in handle.ts and the
    // database keeps the old rule with no error of its own. These two lines are the
    // alarm, and they are the reason the migration says the duplication is checked.
    expect(HANDLE_MIN_LENGTH).toBe(3);
    expect(HANDLE_MAX_LENGTH).toBe(20);

    // Nothing survived any of the attempts: the rollback is this file's, not the
    // database's, so the run leaves no row behind for a later one to trip over.
    expect(await prisma.user.count({ where: { phoneNumber: e164 } })).toBe(0);
  });

  it('verifies the code, activating the user and consuming the code', async () => {
    const { local, e164 } = freshNumber();

    const registration = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local })
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

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ pin: PIN, phoneNumber: local }).expect(201);
    const code = latestCodeFor(e164);

    await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(409);

    expect(response.body.message).toContain('already verified');
  });

  it('answers 404 for a number that never registered, creating nothing', async () => {
    const local = takeReservedNumber();
    const e164 = toE164(local);

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: '123456' });

    /**
     * The message carries what a failure needs to be diagnosable, because this assertion
     * has failed once without being reproducible: an unregistered number was answered
     * 400 - the answer `verifyOtp` gives when a row *does* exist and its code is wrong,
     * expired or already gone - instead of 404. The row count is in the message for that
     * reason, and this number is reserved rather than drawn here (`takeReservedNumber`)
     * so that "never registered" is a fact the `beforeAll` hook established.
     */
    expect(
      response.status,
      `expected 404 from ${VERIFY_PATH} for an unregistered number, got ${
        response.status
      } ${JSON.stringify(response.body)} (rows with this number: ${await prisma.user.count({
        where: { phoneNumber: e164 },
      })})`,
    ).toBe(404);
    expect(response.body.message).toContain('No registration found');
    expect(await prisma.user.count({ where: { phoneNumber: toE164(local) } })).toBe(0);
  });

  it('counts wrong guesses, then locks the code on the attempt that uses them up', async () => {
    const { local, e164 } = freshNumber();

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ pin: PIN, phoneNumber: local }).expect(201);
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

    await request(app.getHttpServer()).post(REGISTER_PATH).send({ pin: PIN, phoneNumber: local }).expect(201);
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
      await request(app.getHttpServer())
        .post(REGISTER_PATH)
        .send({ pin: PIN, phoneNumber: local })
        .expect(201);
    }

    expect(smsSender.for(e164)).toHaveLength(REQUESTS_PER_WINDOW);

    const blocked = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local })
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

  it('starts a session when a number is verified, storing only the digest of its refresh token', async () => {
    const { local, e164 } = freshNumber();

    const session = await registerAndVerify(app, local, e164);

    expect(new Date(session.accessTokenExpiresAt).toISOString()).toBe(session.accessTokenExpiresAt);
    expect(new Date(session.refreshExpiresAt).toISOString()).toBe(session.refreshExpiresAt);

    // The asymmetry the whole design rests on: an access token that dies in minutes and
    // a refresh token that lives for a month, so the app refreshes rather than re-signs.
    const accessTtl = new Date(session.accessTokenExpiresAt).getTime() - Date.now();

    expect(accessTtl).toBeGreaterThan(ACCESS_TOKEN_TTL_MINUTES * MINUTE_MS - MINUTE_MS);
    expect(accessTtl).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MINUTES * MINUTE_MS);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: digestOf(session.refreshToken) },
    });

    expect(stored?.userId).toBe(session.userId);
    expect(stored?.revokedAt).toBeNull();
    expect(stored?.expiresAt.getTime() ?? 0).toBeGreaterThan(
      Date.now() + (REFRESH_TOKEN_TTL_DAYS - 1) * DAY_MS,
    );
    // A plaintext session in the table would be a working credential for anyone who
    // reads the database; the digest is what a presented token is matched against.
    expect(stored?.tokenHash).not.toBe(session.refreshToken);

    // ...and the access token opens the one guarded route in the API.
    const profile = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(session.accessToken))
      .expect(200);

    expect(profile.body).toEqual({
      userId: session.userId,
      phoneNumber: e164,
      status: UserStatus.ACTIVE,
      handle: null,
    });
  });

  it('asks for a wallet for the user whose number was just verified (Step 19)', async () => {
    const { local, e164 } = freshNumber();
    const before = provisioning.provisioned.length;

    const session = await registerAndVerify(app, local, e164);

    // One wallet, for the row the database holds - and it is asked for *inside* the verify
    // request, which is what makes the account exist "without the user doing anything
    // else". `AccountProvisioningService` is the stub here (see
    // `RecordingProvisioning`), so what this proves is the trigger rather than the wallet.
    expect(provisioning.provisioned.slice(before)).toEqual([session.userId]);

    // And nothing about it is in the response: a client that could read a provisioning
    // stage out of the verification body would be a client making a decision that belongs
    // to the service.
    expect(JSON.stringify(session)).not.toContain('wallet');
  });

  it('registers, verifies and provisions without collecting a PIN (Step 34d)', async () => {
    const { local, e164 } = freshNumber();
    const before = provisioning.provisioned.length;

    // No `pin` in the body: the account is created without one, and everything else about the
    // flow is unchanged - that is the claim this test exists to make.
    await request(app.getHttpServer()).post(REGISTER_PATH).send({ phoneNumber: local }).expect(201);

    const pending = await prisma.user.findUnique({ where: { phoneNumber: e164 } });

    expect(pending?.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(pending?.transactionPinHash).toBeNull();

    const code = latestCodeFor(e164);

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code })
      .expect(200);

    expect(response.body).toMatchObject({ phoneNumber: e164, status: UserStatus.ACTIVE });

    const active = await prisma.user.findUnique({ where: { phoneNumber: e164 } });

    expect(active?.status).toBe(UserStatus.ACTIVE);
    // Still no PIN, and it stopped nothing: the account activated and asked for a wallet just
    // like one registered with a PIN, because nothing in this flow reads the PIN.
    expect(active?.transactionPinHash).toBeNull();
    expect(provisioning.provisioned.slice(before)).toEqual([active?.id as string]);
  });

  it('adds a second session when a code is used to sign in, without touching the first', async () => {
    const { local, e164 } = freshNumber();

    const firstDevice = await registerAndVerify(app, local, e164);
    const secondDevice = await signInWithCode(app, local, e164);

    expect(secondDevice.userId).toBe(firstDevice.userId);
    expect(secondDevice.refreshToken).not.toBe(firstDevice.refreshToken);
    // No handle was submitted at registration, and sign-in reports the row as it is.
    expect(secondDevice.handle).toBeNull();

    // Two live sessions: signing in on a new device is not a reason to end the one on
    // the old one, and both tokens still open the guarded route.
    expect(
      await prisma.refreshToken.count({ where: { userId: firstDevice.userId, revokedAt: null } }),
    ).toBe(2);
    await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(secondDevice.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(firstDevice.accessToken))
      .expect(200);
  });

  it('refuses a sign-in code that has already been used, starting no session for it', async () => {
    const { local, e164 } = freshNumber();

    const session = await registerAndVerify(app, local, e164);

    await request(app.getHttpServer())
      .post(LOGIN_CODE_PATH)
      .send({ phoneNumber: local })
      .expect(200);

    const code = latestCodeFor(e164);

    await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .send({ phoneNumber: local, code })
      .expect(200);

    // One live code per number and one use per code, so the second attempt gets the
    // answer verification gives a spent code: ask for a new one - which is the only way
    // forward for the honest case (a double tap) as well.
    const reused = await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .send({ phoneNumber: local, code })
      .expect(400);

    expect(reused.body.message).toContain('No verification code is outstanding');
    // The session from verification and the one from the successful sign-in, and
    // nothing from the refused attempt.
    expect(await prisma.refreshToken.count({ where: { userId: session.userId } })).toBe(2);
  });

  it('rotates on refresh, then treats the spent token as a compromise when it comes back', async () => {
    const { local, e164 } = freshNumber();

    const session = await registerAndVerify(app, local, e164);

    const rotated = await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
    // No profile on refresh: the client has a session already, and `GET /auth/session`
    // is where a user is read - from the row, not from a token.
    expect(rotated.body).not.toHaveProperty('userId');

    // The token that was spent comes back. A replay, or a client that kept a copy it
    // should have replaced: either way the value is out of our control.
    const replayed = await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: session.refreshToken })
      .expect(401);

    expect(replayed.body.message).toContain('security reasons');

    // The family went with it: the token issued in exchange is dead too, so every
    // session for this user has to be rebuilt by signing in again.
    await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: rotated.body.refreshToken as string })
      .expect(401);

    expect(
      await prisma.refreshToken.count({ where: { userId: session.userId, revokedAt: null } }),
    ).toBe(0);

    // The access token handed out with the rotation still works - and that is the
    // documented cost of the design, not a gap: it is signed rather than stored, so
    // nothing can withdraw it before its 15 minutes are up. It is exactly why the
    // refresh half is the one that is rotated, revoked and kept in the database.
    await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(rotated.body.accessToken as string))
      .expect(200);
  });

  it('logs out idempotently, ending only the session that was presented', async () => {
    const { local, e164 } = freshNumber();

    const phone = await registerAndVerify(app, local, e164);
    const tablet = await signInWithCode(app, local, e164);

    const loggedOut = await request(app.getHttpServer())
      .post(LOGOUT_PATH)
      .send({ refreshToken: tablet.refreshToken })
      .expect(204);

    expect(loggedOut.body).toEqual({});

    // One session ended, and the row says so...
    expect(
      await prisma.refreshToken.count({ where: { userId: phone.userId, revokedAt: null } }),
    ).toBe(1);

    // ...so the other device carries on: a phone and a tablet are two sessions, and
    // signing out on one must not sign the user out of the other.
    await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: phone.refreshToken })
      .expect(200);

    // Logging out twice is not an error: the client asked for the same thing again, and
    // a 401 here would leave it on a "logout failed" screen with nothing useful to do.
    await request(app.getHttpServer())
      .post(LOGOUT_PATH)
      .send({ refreshToken: tablet.refreshToken })
      .expect(204);
  });

  it('treats a refresh with a logged-out token as a compromise and retires the family', async () => {
    const { local, e164 } = freshNumber();

    const phone = await registerAndVerify(app, local, e164);
    const tablet = await signInWithCode(app, local, e164);

    await request(app.getHttpServer())
      .post(LOGOUT_PATH)
      .send({ refreshToken: tablet.refreshToken })
      .expect(204);

    /**
     * The documented cost of reuse detection, and the honest reason for it: a token that
     * has been revoked looks the same whether it was rotated away or logged out - the
     * row says "already revoked" and nothing more - so presenting one is answered the
     * way a replay is, and every live session for the user goes with it.
     *
     * The alternative is a `revokedReason` column (`ROTATED`/`LOGGED_OUT`) to tell the
     * two apart, and the reason it is not here yet is what gets traded away: a stolen
     * refresh token whose owner logged out would keep working. The client's side of the
     * contract is that a logged-out token is never presented again - the app drops it -
     * so this path is reached by a bug or by someone else's copy.
     */
    const replayed = await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: tablet.refreshToken })
      .expect(401);

    expect(replayed.body.message).toContain('security reasons');

    // The other device had a perfectly good session a moment ago, and it is gone too.
    expect(
      await prisma.refreshToken.count({ where: { userId: phone.userId, revokedAt: null } }),
    ).toBe(0);
    await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: phone.refreshToken })
      .expect(401);
  });

  it('refuses the guarded route without a token this API signed', async () => {
    const missing = await request(app.getHttpServer()).get(SESSION_PATH).expect(401);

    expect(missing.body.message).toContain('Invalid or expired access token');

    // A value that is not a JWT at all, and a real one whose signature is broken by a
    // single character. The client's next step is the same for both, so the answer is
    // the same for both - and neither tells a prober which of the two it was.
    const garbage = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);

    expect(garbage.body.message).toBe(missing.body.message);

    const { local, e164 } = freshNumber();
    const session = await registerAndVerify(app, local, e164);
    const tampered = `${session.accessToken.slice(0, -1)}${
      session.accessToken.endsWith('A') ? 'B' : 'A'
    }`;

    const forged = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(tampered))
      .expect(401);

    expect(forged.body.message).toBe(missing.body.message);
  });

  /**
   * Step 16's audit item, taken literally: "access tokens genuinely expire at 15
   * minutes (not just configured to - verify with a token issued in the past)".
   *
   * The token below is minted by the same `JwtService` that signs every real one - same
   * secret, issuer, audience and algorithm - for a user who exists and whose session is
   * live. The only thing wrong with it is `exp`, one minute in the past. That is what
   * makes this a different test from the one above: the signature and the claims are
   * perfect, so the 401 can only be the expiry check.
   *
   * It has to be a request rather than an assertion about `ACCESS_TOKEN_TTL_MINUTES`,
   * because the configuration could be read and asserted while the API still accepted
   * expired tokens: `ignoreExpiration: false` in `JwtStrategy` is the thing that
   * actually enforces the lifetime, and this is the only test that would fail if
   * somebody flipped it.
   */
  it('refuses an access token whose lifetime has already run out', async () => {
    const { local, e164 } = freshNumber();

    const session = await registerAndVerify(app, local, e164);

    const jwt = app.get(JwtService, { strict: false });
    const expired = jwt.sign({ sub: session.userId }, { expiresIn: -SECONDS_PER_MINUTE });

    // Reading the payload is what rules out "this failed because the claims were wrong":
    // the user id is the one the API signs, and `exp` is the only broken part.
    const claims = jwt.decode<{ sub: string; exp: number }>(expired);

    expect(claims.sub).toBe(session.userId);
    expect(claims.exp).toBeLessThan(Math.floor(Date.now() / 1_000));

    // The same user on the same route with a token that has not run out: 200. So the 401
    // below is about this token, not about the account or the route. The failure carries
    // the response and the token's lifetime against the clock, because this assertion
    // once failed with a 401 for a token that was valid by signature, issuer, audience
    // and (by every reading of the code) lifetime, and "expected 200, got 401" alone says
    // nothing about which part of the token the API refused.
    const stillValid = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(session.accessToken));

    expect(
      stillValid.status,
      `expected 200 from ${SESSION_PATH} with the access token just issued, got ${
        stillValid.status
      } ${JSON.stringify(stillValid.body)} (${tokenState(session.accessToken)})`,
    ).toBe(200);

    const refused = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(expired))
      .expect(401);

    // Expired, malformed and wrong-signature all get the one message: the client does
    // the same thing in every case, so the API does not say which it was.
    expect(refused.body.message).toContain('Invalid or expired access token');
  });

  it('answers a value that is not one of our refresh tokens as a 401 refresh and a 204 logout', async () => {
    const bogus = 'this-is-not-one-of-our-refresh-tokens';

    const refused = await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: bogus })
      .expect(401);

    expect(refused.body.message).toContain('Invalid or expired refresh token');

    /**
     * The same value, on the same body shape, answered with 204 - and the asymmetry is
     * the design rather than an oversight. Refresh is a credential being presented as
     * access, so a bad one is refused; logout is a credential being thrown away, and a
     * value that was never a session has already been thrown away.
     */
    await request(app.getHttpServer()).post(LOGOUT_PATH).send({ refreshToken: bogus }).expect(204);
  });

  it('refuses a suspended account at every door it can be checked at', async () => {
    const { local, e164 } = freshNumber();

    const session = await registerAndVerify(app, local, e164);

    // The code is requested *before* the suspension, so none of the refusals below can
    // be about a missing code: they are about the account.
    await request(app.getHttpServer())
      .post(LOGIN_CODE_PATH)
      .send({ phoneNumber: local })
      .expect(200);

    const code = latestCodeFor(e164);

    await prisma.user.update({
      where: { id: session.userId },
      data: { status: UserStatus.SUSPENDED },
    });

    // Refused at the door rather than at its expiry: `JwtStrategy` re-reads the row on
    // every request, which is what makes a suspension immediate instead of a 15-minute
    // wait - the reason the token cannot be trusted on its own.
    const profile = await request(app.getHttpServer())
      .get(SESSION_PATH)
      .set('Authorization', bearer(session.accessToken));

    /**
     * 401 here would mean the token was refused before the suspension was ever read, so
     * the failure carries both halves: what the API answered, and the token's own lifetime
     * against the current clock (see `tokenState` - a 403 was once answered with a 401 in
     * an 18-second run).
     */
    expect(
      profile.status,
      `expected 403 (suspended) from ${SESSION_PATH}, got ${
        profile.status
      } ${JSON.stringify(profile.body)} (${tokenState(session.accessToken)})`,
    ).toBe(403);

    expect(profile.body.message).toContain('suspended');

    // Renewing is refused too, or a suspension would last only until the next refresh.
    await request(app.getHttpServer())
      .post(REFRESH_PATH)
      .send({ refreshToken: session.refreshToken })
      .expect(403);

    // ...and both sign-in doors say the same thing, before any code is compared: a
    // suspended user is not told their code was wrong and sent to request another one
    // that cannot work either.
    await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .send({ phoneNumber: local, code })
      .expect(403);
    await request(app.getHttpServer())
      .post(LOGIN_CODE_PATH)
      .send({ phoneNumber: local })
      .expect(403);
  });
});
