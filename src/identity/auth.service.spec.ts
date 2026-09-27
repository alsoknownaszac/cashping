import { HttpException, UnauthorizedException } from '@nestjs/common';
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
import { type IssuedTokens, type SessionUser, type TokenService } from './token/token.service.js';

/**
 * Steps 10, 14 and 16: the decisions `AuthService` makes, in the order it makes them.
 *
 * Everything around it is faked, so each test names one behaviour - which status
 * code a given situation produces, and crucially *what must not have happened*
 * (no SMS on a 409, no row on a 429, no user created for an unparseable number, no
 * session started by a code that was already spent). The database and Redis are
 * exercised for real in `test/auth.e2e-spec.ts`.
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
  handle: string | null;
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

        const user = [...this.users.values()].find((candidate) => candidate.id === args.where.id);

        if (user === undefined) {
          throw new Error(`no user with id ${args.where.id}`);
        }

        Object.assign(user, args.data);

        return user;
      },
    },
  };

  /**
   * The same table, outside a transaction: `verifyOtp` spends the code inside one,
   * `login` spends it with a single write of its own.
   */
  readonly otpVerification = {
    updateMany: async (): Promise<{ count: number }> => {
      this.calls.push('consume');

      return { count: this.consumeCount };
    },
  };

  readonly user = {
    findUnique: async (args: { where: { phoneNumber: string } }): Promise<FakeUser | null> => {
      this.calls.push('findUnique');

      return this.users.get(args.where.phoneNumber) ?? null;
    },
    create: async (args: {
      data: { phoneNumber: string; handle?: string | null };
    }): Promise<FakeUser> => {
      this.calls.push('create');

      const user: FakeUser = {
        id: `user-${this.nextId++}`,
        phoneNumber: args.data.phoneNumber,
        handle: args.data.handle ?? null,
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

/**
 * The token mint, recording every decision asked of it.
 *
 * `AuthService` is deliberately thin here: it hands the row over and passes the
 * answer back, so what these tests assert is *which* user was handed over, *in
 * what order* the code was spent, and that a rejection travels out unchanged.
 */
class FakeTokenService {
  readonly issued: SessionUser[] = [];
  readonly rotated: string[] = [];
  readonly revoked: string[] = [];

  issuedPair: IssuedTokens = {
    accessToken: 'access-token-1',
    accessTokenExpiresAt: new Date('2026-09-26T10:19:12.345Z'),
    refreshToken: 'refresh-token-1',
    refreshExpiresAt: new Date('2026-10-26T10:04:12.345Z'),
  };

  /** Set to make `rotate` throw the way a reused token does. */
  rotateError: Error | null = null;

  /** What `revoke` answers; `false` is the already-dead token. */
  revokeResult = true;

  issue = async (user: SessionUser): Promise<IssuedTokens> => {
    this.issued.push(user);

    return this.issuedPair;
  };

  rotate = async (presented: string): Promise<IssuedTokens> => {
    if (this.rotateError !== null) {
      throw this.rotateError;
    }

    this.rotated.push(presented);

    return this.issuedPair;
  };

  revoke = async (presented: string): Promise<boolean> => {
    this.revoked.push(presented);

    return this.revokeResult;
  };
}

interface Harness {
  prisma: FakePrisma;
  otp: FakeOtpService;
  limiter: FakeRateLimiter;
  notifications: FakeNotifications;
  tokens: FakeTokenService;
  auth: AuthService;
}

function createHarness(): Harness {
  const prisma = new FakePrisma();
  const otp = new FakeOtpService();
  const limiter = new FakeRateLimiter();
  const notifications = new FakeNotifications();
  const tokens = new FakeTokenService();

  return {
    prisma,
    otp,
    limiter,
    notifications,
    tokens,
    auth: new AuthService(
      prisma as unknown as PrismaService,
      createConfig(),
      otp as unknown as OtpService,
      limiter as unknown as OtpRateLimiterService,
      notifications as unknown as NotificationsService,
      tokens as unknown as TokenService,
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
    handle: null,
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
    [
      'no live code',
      { ok: false, reason: 'not_found' },
      400,
      /No verification code is outstanding/,
    ],
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

  it('activates the user, spends the code and starts a session in one transaction', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
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

    // The pair comes out of the same code: the proof that this is the user's phone is
    // also the credential that starts their session, so a fresh install has no second
    // sign-in step to make.
    expect(response.accessToken).toBe('access-token-1');
    expect(response.accessTokenExpiresAt).toBe('2026-09-26T10:19:12.345Z');
    expect(response.refreshToken).toBe('refresh-token-1');
    expect(response.refreshExpiresAt).toBe('2026-10-26T10:04:12.345Z');

    // The row is handed over as `ACTIVE` - patched in memory rather than re-read - since
    // `TokenService.issue` reads nothing but the id.
    expect(tokens.issued).toHaveLength(1);
    expect(tokens.issued[0]).toMatchObject({ id: user.id, status: UserStatus.ACTIVE });
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

describe('AuthService.requestLoginCode', () => {
  it('texts a code to a verified number and answers with what the code screen renders', async () => {
    const { auth, prisma, otp, limiter, notifications } = createHarness();
    const user = seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });

    const response = await auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER });

    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(response.codeLength).toBe(6);
    expect(new Date(response.expiresAt).toISOString()).toBe(response.expiresAt);
    // The row is found by its normalized number, the code is issued against that row's
    // own id (so a resend invalidates whatever was sent before), and the SMS is the only
    // route the code has to the user.
    expect(otp.issued).toEqual([user.id]);
    expect(limiter.consumed).toEqual([E164_NUMBER]);
    expect(notifications.sent).toEqual([{ phoneNumber: E164_NUMBER, code: '654321' }]);
  });

  it('answers 404 for a number with no account, before spending the allowance', async () => {
    const { auth, prisma, otp, limiter, notifications } = createHarness();

    const { status } = await captureHttpError(() =>
      auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(404);
    expect(prisma.calls).toEqual(['findUnique']);
    // Registration's ordering rule, unchanged: a request that sends no SMS must not spend
    // the number's allowance, or three mistyped numbers would lock the real user out.
    expect(limiter.consumed).toEqual([]);
    expect(otp.issued).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 403 for a suspended account without issuing or sending anything', async () => {
    const { auth, prisma, otp, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.SUSPENDED });

    const { status } = await captureHttpError(() =>
      auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(403);
    expect(otp.issued).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 409 while registration is unfinished, because sign-in needs a verified number', async () => {
    const { auth, prisma, otp } = createHarness();
    // PENDING_VERIFICATION: `register`'s resend path, not a sign-in candidate.
    seedUser(prisma);

    const { status, message } = await captureHttpError(() =>
      auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(409);
    expect(message).toContain('not been verified');
    // The screen they need is the verification one; a sign-in code would be a dead end.
    expect(otp.issued).toEqual([]);
  });

  it('refuses the request past the rate limit, after the account checks', async () => {
    const { auth, prisma, limiter, otp, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });
    limiter.error = new OtpRateLimitExceededError(900);

    const { status, message } = await captureHttpError(() =>
      auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(429);
    expect(message).toContain('Try again in 15 minutes');
    expect(otp.issued).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 503 when the SMS provider refuses, leaving the code for a retry', async () => {
    const { auth, prisma, otp, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });
    notifications.error = new SmsDeliveryError('the provider rejected the message');

    const { status } = await captureHttpError(() =>
      auth.requestLoginCode({ phoneNumber: LOCAL_NUMBER }),
    );

    expect(status).toBe(503);
    // The code was issued before the send failed, and that is harmless: the user never
    // saw it, and asking again is another send - rate limited like any other.
    expect(otp.issued).toHaveLength(1);
    expect(notifications.sent).toHaveLength(0);
  });
});
describe('AuthService.login', () => {
  it('spends the code and starts a session, writing nothing to the user row', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
    const verifiedAt = new Date('2026-09-01T08:30:00.000Z');
    const user = seedUser(prisma, {
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: verifiedAt,
      handle: 'miriam_owusu',
    });

    const response = await auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    expect(response.userId).toBe(user.id);
    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(response.status).toBe(UserStatus.ACTIVE);
    // The handle rides along with the session, so the app has a name to render without a
    // second round trip to `GET /auth/session`.
    expect(response.handle).toBe('miriam_owusu');
    expect(response.accessToken).toBe('access-token-1');
    expect(response.accessTokenExpiresAt).toBe('2026-09-26T10:19:12.345Z');
    expect(response.refreshToken).toBe('refresh-token-1');
    expect(response.refreshExpiresAt).toBe('2026-10-26T10:04:12.345Z');

    // Checked against the stored row's id, with the code exactly as the user typed it.
    expect(otp.checked).toEqual([{ userId: user.id, code: '123456' }]);

    // One write - spending the code - and no transaction around it: signing in changes
    // nothing about the account, which is the whole difference from verification.
    expect(prisma.calls).toEqual(['findUnique', 'consume']);
    expect(prisma.transactionCount).toBe(0);
    // `phoneVerifiedAt` records when the *number* was proven; a sign-in that re-stamped it
    // would be a lie about that.
    expect(user.phoneVerifiedAt).toEqual(verifiedAt);

    // The row as it was read, with no in-memory patch - because nothing was written.
    expect(tokens.issued).toEqual([user]);
  });

  it('refuses a code that was already used, and starts no session for it', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });
    // Live when it was checked and gone by the time it is spent: the same person
    // double-tapping "sign in", or two devices racing with one code.
    prisma.consumeCount = 0;

    const { status, message } = await captureHttpError(() =>
      auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(409);
    expect(message).toContain('already been used');
    expect(otp.checked).toHaveLength(1);
    // The order `login` defends: spend first, mint second. The other way round leaves a
    // live session behind on a failed write, and a session nobody was handed is an open
    // door - while a lost code costs one SMS to replace.
    expect(tokens.issued).toEqual([]);
  });

  it('answers 404 for a number with no account, without checking any code', async () => {
    const { auth, otp, tokens } = createHarness();

    const { status } = await captureHttpError(() =>
      auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(404);
    expect(otp.checked).toEqual([]);
    expect(tokens.issued).toEqual([]);
  });

  it('answers 403 for a suspended account, before the code is even looked at', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
    seedUser(prisma, { status: UserStatus.SUSPENDED });

    const { status } = await captureHttpError(() =>
      auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(403);
    // Checked before the comparison, so a suspended user is not told their code was wrong
    // and sent to request another one that cannot work either.
    expect(otp.checked).toEqual([]);
    expect(tokens.issued).toEqual([]);
    // One query, and it is the shared `findSignInAccount`: the same answer "text me a
    // code" gives, rather than a second copy of the rules.
    expect(prisma.calls).toEqual(['findUnique']);
  });

  it('answers 409 for a number whose registration is unfinished', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
    seedUser(prisma);

    const { status, message } = await captureHttpError(() =>
      auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' }),
    );

    expect(status).toBe(409);
    expect(message).toContain('not been verified');
    expect(otp.checked).toEqual([]);
    expect(tokens.issued).toEqual([]);
  });

  it('maps a wrong code onto the answer verification gives, and starts no session', async () => {
    const { auth, prisma, otp, tokens } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });
    otp.outcome = { ok: false, reason: 'invalid_code', attemptsRemaining: 3 };

    const { status, message } = await captureHttpError(() =>
      auth.login({ phoneNumber: LOCAL_NUMBER, code: '000000' }),
    );

    expect(status).toBe(400);
    expect(message).toContain('3 attempts remaining');
    // A failed outcome never produced an `otpId`, so nothing was spent and no session
    // exists to revoke.
    expect(prisma.calls).toEqual(['findUnique']);
    expect(tokens.issued).toEqual([]);
  });
});

describe('AuthService.refresh', () => {
  it('passes the presented token through and returns the rotated pair', async () => {
    const { auth, tokens } = createHarness();

    const response = await auth.refresh({ refreshToken: 'opaque-refresh-token' });

    expect(response).toEqual({
      accessToken: 'access-token-1',
      accessTokenExpiresAt: '2026-09-26T10:19:12.345Z',
      refreshToken: 'refresh-token-1',
      refreshExpiresAt: '2026-10-26T10:04:12.345Z',
    });
    // No profile here, unlike login and verification: a client that is refreshing already
    // knows who it is, and `GET /auth/session` reads the row itself.
    expect(response).not.toHaveProperty('userId');
    // Every decision - the digest lookup, reuse detection, expiry, rotation - belongs to
    // `TokenService`; this is the mapping to the wire and nothing else.
    expect(tokens.rotated).toEqual(['opaque-refresh-token']);
  });

  it('lets a refusal travel out unchanged, so each condition has one wording', async () => {
    const { auth, tokens } = createHarness();
    // What a replayed token produces: `TokenService` has already retired the family by the
    // time this is thrown.
    tokens.rotateError = new UnauthorizedException(
      'Invalid or expired refresh token. Sign in again.',
    );

    const { status, message } = await captureHttpError(() =>
      auth.refresh({ refreshToken: 'replayed-token' }),
    );

    expect(status).toBe(401);
    expect(message).toBe('Invalid or expired refresh token. Sign in again.');
  });
});

describe('AuthService.logout', () => {
  it('revokes the presented token and answers with nothing', async () => {
    const { auth, tokens } = createHarness();

    await expect(auth.logout({ refreshToken: 'opaque-refresh-token' })).resolves.toBeUndefined();

    expect(tokens.revoked).toEqual(['opaque-refresh-token']);
  });

  it('answers the same way for a token that was not live, because logout is idempotent', async () => {
    const { auth, tokens } = createHarness();
    // Already rotated away, expired, or never existed: a client that logs out twice gets
    // the same empty answer either way, rather than a 401 it has to special-case - and a
    // caller cannot use this endpoint to test whether a token was real.
    tokens.revokeResult = false;

    await expect(auth.logout({ refreshToken: 'already-gone' })).resolves.toBeUndefined();

    expect(tokens.revoked).toEqual(['already-gone']);
  });
});

describe('AuthService.session', () => {
  it('maps the row the guard read, without querying anything', () => {
    const { auth, prisma } = createHarness();

    const response = auth.session({
      id: 'user-9',
      phoneNumber: E164_NUMBER,
      status: UserStatus.ACTIVE,
      handle: 'miriam_owusu',
    });

    expect(response).toEqual({
      userId: 'user-9',
      phoneNumber: E164_NUMBER,
      status: UserStatus.ACTIVE,
      handle: 'miriam_owusu',
    });
    // The read already happened in `JwtStrategy`: asking again here would be a second
    // answer to a question that was just answered, and the two could disagree under a
    // concurrent update.
    expect(prisma.calls).toEqual([]);
  });

  it('reports a null handle rather than omitting it, so the client can render a blank name', () => {
    const { auth } = createHarness();

    const response = auth.session({
      id: 'user-9',
      phoneNumber: E164_NUMBER,
      status: UserStatus.ACTIVE,
      handle: null,
    });

    expect(response).toHaveProperty('handle', null);
  });
});
