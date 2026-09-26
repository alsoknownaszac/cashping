import { HttpException } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { UserStatus } from '../generated/prisma/enums.js';
import { type NotificationsService } from '../notifications/notifications.service.js';
import { SmsDeliveryError } from '../notifications/sms/sms-sender.js';
import { type PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import {
  OtpRateLimitExceededError,
  OtpRateLimitUnavailableError,
  type OtpRateLimiterService,
} from './otp/otp-rate-limiter.service.js';
import { type IssuedOtp, type OtpCheckOutcome, type OtpService } from './otp/otp.service.js';

/**
 * Steps 10 and 14: the decisions `AuthService` makes, in the order it makes them.
 *
 * Everything around it is faked, so each test names one behaviour - which status
 * code a given situation produces, and crucially *what must not have happened*
 * (no SMS on a 409, no row on a 429, no user created for an unparseable number).
 * The database and Redis are exercised for real in `test/auth.e2e-spec.ts`.
 */

/** A Ghanaian mobile written the way a user types it, and how it must be stored. */
const LOCAL_NUMBER = '024 123 4567';
const E164_NUMBER = '+233241234567';

const OTP_CONFIG: Readonly<Record<string, number | string>> = {
  'phone.defaultRegion': 'GH',
  'otp.codeLength': 6,
};

function createConfig(): ConfigService {
  return { getOrThrow: (key: string) => OTP_CONFIG[key] } as unknown as ConfigService;
}

interface FakeUser {
  id: string;
  phoneNumber: string;
  status: UserStatus;
  phoneVerifiedAt: Date | null;
}

/** The two tables `AuthService` touches, plus a log of the calls it made. */
class FakePrisma {
  /** Keyed by phone number: the unique index is the behaviour under test. */
  readonly users = new Map<string, FakeUser>();

  /** Every call, in order, so the sequence of decisions can be asserted. */
  readonly calls: string[] = [];

  transactionCount = 0;

  /** What the in-transaction code consume reports; 0 simulates losing the race. */
  consumeCount = 1;

  private nextId = 1;

  readonly tx = {
    otpVerification: {
      updateMany: async (): Promise<{ count: number }> => {
        this.calls.push('tx.consume');

        return { count: this.consumeCount };
      },
    },
    user: {
      update: async (args: {
        where: { id: string };
        data: { status: UserStatus; phoneVerifiedAt: Date };
      }): Promise<FakeUser> => {
        this.calls.push('tx.activate');

        const user = [...this.users.values()].find(
          (candidate) => candidate.id === args.where.id,
        );

        if (user === undefined) {
          throw new Error(`no user with id ${args.where.id}`);
        }

        Object.assign(user, args.data);

        return user;
      },
    },
  };

  readonly user = {
    findUnique: async (args: { where: { phoneNumber: string } }): Promise<FakeUser | null> => {
      this.calls.push('findUnique');

      return this.users.get(args.where.phoneNumber) ?? null;
    },
    create: async (args: { data: { phoneNumber: string } }): Promise<FakeUser> => {
      this.calls.push('create');

      const user: FakeUser = {
        id: `user-${this.nextId++}`,
        phoneNumber: args.data.phoneNumber,
        // The column default, not something the service restates.
        status: UserStatus.PENDING_VERIFICATION,
        phoneVerifiedAt: null,
      };

      this.users.set(user.phoneNumber, user);

      return user;
    },
  };

  async $transaction<T>(work: (tx: FakePrisma['tx']) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.calls.push('begin');

    const result = await work(this.tx);

    this.calls.push('commit');

    return result;
  }
}

/** The OTP service, with the outcome each test wants to provoke. */
class FakeOtpService {
  readonly issued: string[] = [];
  readonly checked: Array<{ userId: string; code: string }> = [];

  issueResult: IssuedOtp = { code: '654321', expiresAt: new Date(Date.now() + 10 * 60_000) };
  outcome: OtpCheckOutcome = { ok: true, otpId: 'otp-1' };

  issue = async (userId: string): Promise<IssuedOtp> => {
    this.issued.push(userId);

    return this.issueResult;
  };

  check = async (userId: string, code: string): Promise<OtpCheckOutcome> => {
    this.checked.push({ userId, code });

    return this.outcome;
  };
}

/** The Redis limiter, recording which numbers were counted and how they answered. */
class FakeRateLimiter {
  readonly consumed: string[] = [];
  error: Error | null = null;

  consume = async (phoneNumber: string): Promise<void> => {
    if (this.error !== null) {
      throw this.error;
    }

    this.consumed.push(phoneNumber);
  };
}

/** The SMS boundary, recording the messages that would have gone out. */
class FakeNotifications {
  readonly sent: Array<{ phoneNumber: string; code: string }> = [];
  error: Error | null = null;

  sendOtp = async (phoneNumber: string, code: string): Promise<void> => {
    if (this.error !== null) {
      throw this.error;
    }

    this.sent.push({ phoneNumber, code });
  };
}

interface Harness {
  prisma: FakePrisma;
  otp: FakeOtpService;
  limiter: FakeRateLimiter;
  notifications: FakeNotifications;
  auth: AuthService;
}

function createHarness(): Harness {
  const prisma = new FakePrisma();
  const otp = new FakeOtpService();
  const limiter = new FakeRateLimiter();
  const notifications = new FakeNotifications();

  return {
    prisma,
    otp,
    limiter,
    notifications,
    auth: new AuthService(
      prisma as unknown as PrismaService,
      createConfig(),
      otp as unknown as OtpService,
      limiter as unknown as OtpRateLimiterService,
      notifications as unknown as NotificationsService,
    ),
  };
}

/** Adds a user as an earlier request would have left it. */
function seedUser(prisma: FakePrisma, overrides: Partial<FakeUser> = {}): FakeUser {
  const user: FakeUser = {
    id: `seed-${prisma.users.size + 1}`,
    phoneNumber: E164_NUMBER,
    status: UserStatus.PENDING_VERIFICATION,
    phoneVerifiedAt: null,
    ...overrides,
  };

  prisma.users.set(user.phoneNumber, user);

  return user;
}

/** Runs `operation` and returns the status and message the client would receive. */
async function captureHttpError(
  operation: () => Promise<unknown>,
): Promise<{ status: number; message: string }> {
  try {
    await operation();
  } catch (caught) {
    if (!(caught instanceof HttpException)) {
      throw caught;
    }

    const response = caught.getResponse();

    return {
      status: caught.getStatus(),
      message:
        typeof response === 'string'
          ? response
          : String((response as { message?: string }).message ?? ''),
    };
  }

  throw new Error('expected an HTTP error, but the call resolved');
}

describe('AuthService.register', () => {
  it('normalizes the number before it is looked up, stored or texted', async () => {
    const { auth, prisma, notifications } = createHarness();

    const response = await auth.register({ phoneNumber: LOCAL_NUMBER });

    // Stored as E.164: the unique index is on this column, so a row written from
    // the raw input would not collide with the next registration of the same
    // number - which is how one person ends up with two accounts.
    expect([...prisma.users.keys()]).toEqual([E164_NUMBER]);
    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(notifications.sent[0]?.phoneNumber).toBe(E164_NUMBER);
  });

  it('answers with the account, the expiry and the code length - never the code', async () => {
    const { auth } = createHarness();

    const response = await auth.register({ phoneNumber: LOCAL_NUMBER });

    expect(response.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(response.userId).toBe('user-1');
    expect(response.codeLength).toBe(6);
    expect(new Date(response.expiresAt).toISOString()).toBe(response.expiresAt);
    // Nothing in the body carries the code: the SMS is its only route out of the
    // API. Matched as an exact value, so a digit string inside the phone number
    // cannot make this pass or fail by accident.
    expect(Object.values(response)).not.toContain('654321');
    expect(JSON.stringify(response)).not.toContain('"654321"');
    expect(response).not.toHaveProperty('code');
  });

  it('creates no row and sends nothing when the number cannot be parsed', async () => {
    const { auth, prisma, notifications } = createHarness();

    const { status, message } = await captureHttpError(() =>
      auth.register({ phoneNumber: 'definitely-not-a-number' }),
    );

    expect(status).toBe(400);
    // The caller's own value comes back, because "which of my numbers was wrong"
    // is the one thing they cannot work out from a generic complaint.
    expect(message).toContain('definitely-not-a-number');
    // Refused before any query or write: there is nothing to store for a number we
    // cannot even parse.
    expect(prisma.calls).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
  });

  it('refuses an already active number with a 409, without sending an SMS', async () => {
    const { auth, prisma, limiter, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE });

    const { status } = await captureHttpError(() => auth.register({ phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(409);
    // Deliberately *before* the rate limit: otherwise anyone could spend a real
    // user's allowance by asking about a number they already know is registered.
    expect(limiter.consumed).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
    expect(prisma.calls).toEqual(['findUnique']);
  });

  it('refuses a suspended number with a 403', async () => {
    const { auth, prisma, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.SUSPENDED });

    const { status } = await captureHttpError(() => auth.register({ phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(403);
    expect(notifications.sent).toHaveLength(0);
  });

  it('reuses a pending row on a resend, so the user keeps their id', async () => {
    const { auth, prisma, otp, notifications } = createHarness();
    const existing = seedUser(prisma);

    const response = await auth.register({ phoneNumber: LOCAL_NUMBER });

    expect(response.userId).toBe(existing.id);
    expect(prisma.users.size).toBe(1);
    expect(prisma.calls).not.toContain('create');
    // The new code is issued for the same user, and `OtpService.issue` invalidates
    // the previous one in the same transaction.
    expect(otp.issued).toEqual([existing.id]);
    expect(notifications.sent).toHaveLength(1);
  });

  it('refuses the request past the rate limit with a 429, leaving nothing behind', async () => {
    const { auth, prisma, limiter, otp, notifications } = createHarness();
    limiter.error = new OtpRateLimitExceededError(900);

    const { status, message } = await captureHttpError(() =>
      auth.register({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(429);
    // "Try again in 15 minutes", not "too many requests": the user needs a next
    // step, and the wait comes from the counter key's own TTL.
    expect(message).toContain('Try again in 15 minutes');
    // Counted before the user row is created, so a blocked caller cannot use the
    // endpoint to fill the table with pending accounts.
    expect(prisma.users.size).toBe(0);
    expect(prisma.calls).not.toContain('create');
    expect(otp.issued).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 503 when the limiter cannot be evaluated at all', async () => {
    const { auth, limiter, notifications } = createHarness();
    limiter.error = new OtpRateLimitUnavailableError();

    const { status } = await captureHttpError(() => auth.register({ phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(503);
    // Fail closed, the same way the limiter does: an unanswerable limit means no
    // send, never "assume it is fine".
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 503 and keeps the pending row when the SMS provider refuses', async () => {
    const { auth, prisma, notifications } = createHarness();
    notifications.error = new SmsDeliveryError('the provider rejected the message');

    const { status } = await captureHttpError(() => auth.register({ phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(503);
    // The row and the code stay: the account cannot be activated without a code
    // the user never received, and deleting the row would race with a concurrent
    // registration for the same number.
    expect(prisma.users.get(E164_NUMBER)?.status).toBe(UserStatus.PENDING_VERIFICATION);
  });
});

describe('AuthService.verifyOtp', () => {
  it('rejects a number with no registration without checking any code', async () => {
    const { auth, otp } = createHarness();

    const { status } = await captureHttpError(() =>
      auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(404);
    // Nothing to compare against, so the OTP table is not even queried.
    expect(otp.checked).toEqual([]);
  });

  it('rejects an already verified number with a 409', async () => {
    const { auth, prisma, otp } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });

    const { status } = await captureHttpError(() =>
      auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(409);
    expect(otp.checked).toEqual([]);
  });

  it('rejects a suspended number with a 403', async () => {
    const { auth, prisma, otp } = createHarness();
    seedUser(prisma, { status: UserStatus.SUSPENDED });

    const { status } = await captureHttpError(() =>
      auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(403);
    expect(otp.checked).toEqual([]);
  });

  it('creates no row for an unparseable number', async () => {
    const { auth, prisma } = createHarness();

    const { status } = await captureHttpError(() =>
      auth.verifyOtp({ phoneNumber: 'not-a-number', code: '123456' }),
    );

    expect(status).toBe(400);
    expect(prisma.calls).toEqual([]);
  });

  /**
   * Each way a code can be refused gets its own status and its own words: "expired,
   * ask for a new one" and "that digit was wrong, three attempts left" are
   * different messages to a person holding a phone.
   */
  const FAILED_CHECKS: ReadonlyArray<
    readonly [string, Extract<OtpCheckOutcome, { ok: false }>, number, RegExp]
  > = [
    ['no live code', { ok: false, reason: 'not_found' }, 400, /No verification code is outstanding/],
    ['an expired code', { ok: false, reason: 'expired' }, 400, /expired/],
    [
      'an out-of-attempts code',
      { ok: false, reason: 'too_many_attempts', attemptsRemaining: 0 },
      429,
      /Too many incorrect attempts/,
    ],
    [
      'a wrong code',
      { ok: false, reason: 'invalid_code', attemptsRemaining: 3 },
      400,
      /3 attempts remaining/,
    ],
  ];

  for (const [description, outcome, expectedStatus, expectedMessage] of FAILED_CHECKS) {
    it(`maps ${description} onto a ${expectedStatus} without activating the user`, async () => {
      const { auth, prisma, otp } = createHarness();
      const user = seedUser(prisma);
      otp.outcome = outcome;

      const { status, message } = await captureHttpError(() =>
        auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '999999' }),
      );

      expect(status).toBe(expectedStatus);
      expect(message).toMatch(expectedMessage);

      // No activation attempt at all, so a rejected code cannot make the account
      // active as a side effect.
      expect(prisma.calls).toEqual(['findUnique']);
      expect(user.status).toBe(UserStatus.PENDING_VERIFICATION);
      expect(user.phoneVerifiedAt).toBeNull();
    });
  }

  it('activates the user and consumes the code in one transaction', async () => {
    const { auth, prisma, otp } = createHarness();
    const user = seedUser(prisma);

    const response = await auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    expect(response.userId).toBe(user.id);
    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(response.status).toBe(UserStatus.ACTIVE);
    // ISO-8601 on the wire, as in `register` - and this is the Day 2 hand-off value.
    expect(new Date(response.phoneVerifiedAt).toISOString()).toBe(response.phoneVerifiedAt);

    // Checked against the stored row's id rather than the submitted number, and
    // with the code exactly as the user typed it.
    expect(otp.checked).toEqual([{ userId: user.id, code: '123456' }]);

    // Consume and activate are one transaction, in that order.
    expect(prisma.transactionCount).toBe(1);
    expect(prisma.calls).toEqual(['findUnique', 'begin', 'tx.consume', 'tx.activate', 'commit']);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.phoneVerifiedAt).not.toBeNull();
  });

  it('accepts a number in any format, because it normalizes before looking it up', async () => {
    const { auth, prisma, otp } = createHarness();
    const user = seedUser(prisma);

    await auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    // `024 123 4567` found the row stored as `+233241234567`.
    expect(otp.checked).toEqual([{ userId: user.id, code: '123456' }]);
  });

  it('refuses a code that was already used, without activating the user', async () => {
    const { auth, prisma } = createHarness();
    const user = seedUser(prisma);
    // The row was live when it was checked and is not any more: the same person
    // double-tapping "verify", most likely.
    prisma.consumeCount = 0;

    const { status, message } = await captureHttpError(() =>
      auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(409);
    expect(message).toContain('already been used');
    // The consume runs before the activation inside the same transaction, so a lost
    // race throws before the user row is touched - and in a real transaction the
    // throw would roll the whole thing back.
    expect(prisma.calls).not.toContain('tx.activate');
    expect(user.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(user.phoneVerifiedAt).toBeNull();
  });
});
