import { HttpException, UnauthorizedException } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditService } from '../audit/audit.service.js';
import { UserStatus } from '../generated/prisma/enums.js';
import { type NotificationsService } from '../notifications/notifications.service.js';
import { SmsDeliveryError } from '../notifications/sms/sms-sender.js';
import { type PrismaService } from '../prisma/prisma.service.js';
import {
  type AccountProvisioningService,
  type ProvisioningOutcome,
} from '../wallet/provisioning/account-provisioning.service.js';
import { AuthService } from './auth.service.js';
import {
  OtpRateLimitExceededError,
  OtpRateLimitUnavailableError,
  type OtpRateLimiterService,
} from './otp/otp-rate-limiter.service.js';
import { type IssuedOtp, type OtpCheckOutcome, type OtpService } from './otp/otp.service.js';
import {
  type PinAttemptOutcome,
  type PinChangeOutcome,
  type PinService,
} from './pin/pin.service.js';
import { type IssuedStepUpToken, type StepUpTokenService } from './pin/step-up-token.service.js';
import { type IssuedTokens, type SessionUser, type TokenService } from './token/token.service.js';
import {
  type EmailService,
  type EmailSetOutcome,
  type EmailVerifyOutcome,
} from './email/email.service.js';
import { type PasswordChangeOutcome, type PasswordService } from './password/password.service.js';

/**
 * Steps 10, 14, 16 and 32: the decisions `AuthService` makes, in the order it makes them.
 *
 * Everything around it is faked, so each test names one behaviour - which status
 * code a given situation produces, and crucially *what must not have happened*
 * (no SMS on a 409, no row on a 429, no user created for an unparseable number, no
 * session started by a code that was already spent, no wallet for a code that was
 * refused, and no audit entry for a request that never got as far as doing anything).
 * The database and Redis are exercised for real in `test/auth.e2e-spec.ts`.
 */

/** A Ghanaian mobile written the way a user types it, and how it must be stored. */
const LOCAL_NUMBER = '024 123 4567';
const E164_NUMBER = '+233241234567';

/** The PIN every registration in this file sends (Step 34a): four digits, or the DTO refuses it. */
const PIN = '1234';

const OTP_CONFIG: Readonly<Record<string, number | string>> = {
  'phone.defaultRegion': 'GH',
  'otp.codeLength': 6,
  'otp.ttlMinutes': 10,
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
  /** The scrypt hash registration writes (Step 34a) - never the PIN itself. */
  transactionPinHash: string | null;
  /**
   * The address the account holds, and when it was *proved* (Step 34c). Both are columns the
   * sign-in reads: an address with a null `emailVerifiedAt` is attached rather than verified, and
   * is not a credential.
   */
  email: string | null;
  emailVerifiedAt: Date | null;
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
    /**
     * The one indexed read a sign-in is: the identifier names the column, so the fake looks in
     * that column rather than scanning an `OR` across both (Step 34c).
     */
    findUnique: async (args: {
      where: { phoneNumber?: string; email?: string };
    }): Promise<FakeUser | null> => {
      this.calls.push('findUnique');

      if (args.where.email !== undefined) {
        const email = args.where.email;

        return [...this.users.values()].find((user) => user.email === email) ?? null;
      }

      if (args.where.phoneNumber !== undefined) {
        return this.users.get(args.where.phoneNumber) ?? null;
      }

      return null;
    },
    create: async (args: {
      data: { phoneNumber: string; handle?: string | null; transactionPinHash?: string };
    }): Promise<FakeUser> => {
      this.calls.push('create');

      const user: FakeUser = {
        id: `user-${this.nextId++}`,
        phoneNumber: args.data.phoneNumber,
        handle: args.data.handle ?? null,
        // The column default, not something the service restates.
        status: UserStatus.PENDING_VERIFICATION,
        phoneVerifiedAt: null,
        transactionPinHash: args.data.transactionPinHash ?? null,
        // Registration writes no address (Step 34c): an address arrives later, at `POST /auth/email`.
        email: null,
        emailVerifiedAt: null,
      };

      this.users.set(user.phoneNumber, user);

      return user;
    },
    /**
     * The resend path, which Step 34a made unconditional: the PIN is written with the row
     * every time, so the update happens even when the handle is not resubmitted.
     *
     * `undefined` means "column not provided" here exactly as it does in Prisma, which is what
     * the service relies on when it sends a handle that was not resubmitted.
     */
    update: async (args: {
      where: { id: string };
      data: { handle?: string; transactionPinHash?: string };
    }): Promise<FakeUser> => {
      this.calls.push('update');

      const user = [...this.users.values()].find((candidate) => candidate.id === args.where.id);

      if (user === undefined) {
        throw new Error(`no user with id ${args.where.id}`);
      }

      if (args.data.handle !== undefined) {
        user.handle = args.data.handle;
      }

      if (args.data.transactionPinHash !== undefined) {
        user.transactionPinHash = args.data.transactionPinHash;
      }

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

/** The Redis limiter, recording which identifiers were counted and how they answered. */
class FakeRateLimiter {
  /** The subjects counted, in order: the identifier the counted request was about. */
  readonly consumed: string[] = [];
  /** The mask that travelled with each subject, which is what the limiter would log (Step 34c). */
  readonly masks: string[] = [];
  error: Error | null = null;

  consume = async (subject: string, masked: string = subject): Promise<void> => {
    if (this.error !== null) {
      throw this.error;
    }

    this.consumed.push(subject);
    this.masks.push(masked);
  };
}

/** The SMS boundary, recording the messages that would have gone out. */
class FakeNotifications {
  readonly sent: Array<{ phoneNumber: string; code: string }> = [];
  /** Step 34c: what was emailed, so a test can read the code back out of it. */
  readonly emails: Array<{ email: string; code: string }> = [];
  error: Error | null = null;
  emailError: Error | null = null;

  sendOtp = async (phoneNumber: string, code: string): Promise<void> => {
    if (this.error !== null) {
      throw this.error;
    }

    this.sent.push({ phoneNumber, code });
  };

  sendEmailVerification = async (email: string, code: string): Promise<void> => {
    if (this.emailError !== null) {
      throw this.emailError;
    }

    this.emails.push({ email, code });
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

/**
 * `AccountProvisioningService` as `AuthService` is allowed to see it (Step 19).
 *
 * One method, and the shape of its return value is the point: `provisionFor` *reports* an
 * outcome rather than throwing one, which is what `verifyOtp` is built on. `throwWith`
 * exists to prove the other half - that even if that contract were broken, the flow is not
 * relying on it in a way that changes what the client sees.
 */
class FakeProvisioning {
  /**
   * The transaction's own call log, shared so a call here lands *between* its lines.
   * That is the only way to tell "provisioned after the commit" from "provisioned
   * inside the transaction", which are different promises to a user waiting on the
   * response - and the wrong one holds row locks across a faucet call.
   */
  calls: string[] = [];

  readonly provisioned: string[] = [];

  outcome: ProvisioningOutcome = {
    status: 'provisioned',
    accountId: 'account-1',
    publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    funding: 'funded',
    fundingTransactionHash: 'funding-hash',
    trustlineTransactionHash: 'trustline-hash',
  };

  /** Set to make `provisionFor` throw the way nothing in Step 19 actually does. */
  throwWith: Error | null = null;

  provisionFor = async (userId: string): Promise<ProvisioningOutcome> => {
    this.calls.push('provision');

    if (this.throwWith !== null) {
      throw this.throwWith;
    }

    this.provisioned.push(userId);

    return this.outcome;
  };
}

/**
 * `AuditService` as `AuthService` is allowed to see it (Step 32).
 *
 * It shares `FakePrisma`'s call log, exactly as `FakeProvisioning` does, because *where* an entry
 * lands in that sequence is one of this step's decisions: `auth.otp.verified` after the commit and
 * before the wallet, `auth.login` after the code has been spent.
 */
class FakeAudit {
  calls: string[] = [];

  readonly entries: AuditEntry[] = [];

  log = async (entry: AuditEntry): Promise<void> => {
    this.calls.push(`audit:${entry.action}`);
    this.entries.push(entry);
  };
}

/**
 * `PinService` as `AuthService` is allowed to see it (Step 34a).
 *
 * Two methods, and the outcome each test wants - which is what lets this file assert the mapping
 * from an outcome to a status code (401 on the step-up call, 409 on a change, 429 when locked)
 * without a database, a lockout clock or a scrypt hash in the way. `pin.service.spec.ts` is where
 * the arithmetic itself is asserted.
 */
class FakePinService {
  readonly changed: Array<{ userId: string; currentPin: string | undefined; pin: string }> = [];
  readonly verified: Array<{ userId: string; pin: string }> = [];

  changeOutcome: PinChangeOutcome = {
    ok: true,
    pinSetAt: new Date('2026-10-02T10:00:00.000Z'),
  };

  verifyOutcome: PinAttemptOutcome = { ok: true };

  change = async (
    userId: string,
    currentPin: string | undefined,
    pin: string,
  ): Promise<PinChangeOutcome> => {
    this.changed.push({ userId, currentPin, pin });

    return this.changeOutcome;
  };

  verify = async (userId: string, pin: string): Promise<PinAttemptOutcome> => {
    this.verified.push({ userId, pin });

    return this.verifyOutcome;
  };
}

/** `StepUpTokenService`, recording whose PIN a token was minted for. */
class FakeStepUpTokenService {
  readonly issued: string[] = [];

  issuedToken: IssuedStepUpToken = {
    token: 'step-up-token-1',
    expiresAt: new Date('2026-10-02T10:05:00.000Z'),
  };

  issue = async (userId: string): Promise<IssuedStepUpToken> => {
    this.issued.push(userId);

    return this.issuedToken;
  };
}

/**
 * `PasswordService` as `AuthService` is allowed to see it (Step 34b).
 *
 * An outcome each test chooses, so the mapping from an outcome to a status code (409 on a
 * missing or wrong current password) can be asserted without a scrypt hash in the way.
 * `password.service.spec.ts` is where the hashing and the write are asserted.
 */
class FakePasswordService {
  readonly changed: Array<{
    userId: string;
    currentPassword: string | undefined;
    password: string;
  }> = [];
  readonly verified: Array<{ userId: string; password: string }> = [];

  changeOutcome: PasswordChangeOutcome = {
    ok: true,
    passwordSetAt: new Date('2026-10-03T10:00:00.000Z'),
  };

  verifyResult = true;

  change = async (
    userId: string,
    currentPassword: string | undefined,
    password: string,
  ): Promise<PasswordChangeOutcome> => {
    this.changed.push({ userId, currentPassword, password });

    return this.changeOutcome;
  };

  verify = async (userId: string, password: string): Promise<boolean> => {
    this.verified.push({ userId, password });

    return this.verifyResult;
  };

  set = async (_userId: string, _password: string): Promise<Date> =>
    new Date('2026-10-03T10:00:00.000Z');
}

/** `EmailService` as `AuthService` is allowed to see it (Step 34c). */
class FakeEmailService {
  readonly setCalls: Array<{ userId: string; email: string }> = [];
  readonly verified: Array<{ userId: string; code: string }> = [];

  setOutcome: EmailSetOutcome = {
    ok: true,
    email: 'miriam@example.com',
    code: '123456',
    expiresAt: new Date('2026-10-03T10:10:00.000Z'),
  };

  verifyOutcome: EmailVerifyOutcome = {
    ok: true,
    email: 'miriam@example.com',
    emailVerifiedAt: new Date('2026-10-03T10:05:00.000Z'),
  };

  set = async (userId: string, email: string): Promise<EmailSetOutcome> => {
    this.setCalls.push({ userId, email });

    return this.setOutcome;
  };

  verify = async (userId: string, code: string): Promise<EmailVerifyOutcome> => {
    this.verified.push({ userId, code });

    return this.verifyOutcome;
  };
}

interface Harness {
  prisma: FakePrisma;
  otp: FakeOtpService;
  limiter: FakeRateLimiter;
  notifications: FakeNotifications;
  tokens: FakeTokenService;
  provisioning: FakeProvisioning;
  audit: FakeAudit;
  pins: FakePinService;
  stepUpTokens: FakeStepUpTokenService;
  passwords: FakePasswordService;
  emails: FakeEmailService;
  auth: AuthService;
}

function createHarness(): Harness {
  const prisma = new FakePrisma();
  const otp = new FakeOtpService();
  const limiter = new FakeRateLimiter();
  const notifications = new FakeNotifications();
  const tokens = new FakeTokenService();
  const provisioning = new FakeProvisioning();
  const audit = new FakeAudit();
  const pins = new FakePinService();
  const stepUpTokens = new FakeStepUpTokenService();
  const passwords = new FakePasswordService();
  const emails = new FakeEmailService();

  provisioning.calls = prisma.calls;
  audit.calls = prisma.calls;

  return {
    prisma,
    otp,
    limiter,
    notifications,
    tokens,
    provisioning,
    audit,
    pins,
    stepUpTokens,
    passwords,
    emails,
    auth: new AuthService(
      prisma as unknown as PrismaService,
      createConfig(),
      otp as unknown as OtpService,
      limiter as unknown as OtpRateLimiterService,
      notifications as unknown as NotificationsService,
      tokens as unknown as TokenService,
      provisioning as unknown as AccountProvisioningService,
      audit as unknown as AuditService,
      pins as unknown as PinService,
      stepUpTokens as unknown as StepUpTokenService,
      passwords as unknown as PasswordService,
      emails as unknown as EmailService,
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
    // The PIN a previous registration would have written. `null` is the honest default for a row
    // seeded directly, and it is what Step 34d's Google accounts look like.
    transactionPinHash: null,
    // Step 34c: a seeded row holds no address until a test attaches one, and an address is only a
    // credential once `emailVerifiedAt` is set.
    email: null,
    emailVerifiedAt: null,
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

    const response = await auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER });

    // Stored as E.164: the unique index is on this column, so a row written from
    // the raw input would not collide with the next registration of the same
    // number - which is how one person ends up with two accounts.
    expect([...prisma.users.keys()]).toEqual([E164_NUMBER]);
    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(notifications.sent[0]?.phoneNumber).toBe(E164_NUMBER);
  });

  it('answers with the account, the expiry and the code length - never the code', async () => {
    const { auth } = createHarness();

    const response = await auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER });

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
      auth.register({ pin: PIN, phoneNumber: 'definitely-not-a-number' }),
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
    const { auth, prisma, limiter, notifications, audit } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE });

    const { status } = await captureHttpError(() => auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(409);
    // Deliberately *before* the rate limit: otherwise anyone could spend a real
    // user's allowance by asking about a number they already know is registered.
    expect(limiter.consumed).toEqual([]);
    expect(notifications.sent).toHaveLength(0);
    expect(prisma.calls).toEqual(['findUnique']);
    // And no entry (Step 32): nothing was set, so there is nothing to record - and an append-only
    // table that could be filled by a refused request would be a table nobody could trust the shape
    // of. The handles this user does have were recorded when they were claimed.
    expect(audit.entries).toEqual([]);
  });

  it('refuses a suspended number with a 403', async () => {
    const { auth, prisma, notifications } = createHarness();
    seedUser(prisma, { status: UserStatus.SUSPENDED });

    const { status } = await captureHttpError(() => auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(403);
    expect(notifications.sent).toHaveLength(0);
  });

  it('reuses a pending row on a resend, so the user keeps their id', async () => {
    const { auth, prisma, otp, notifications } = createHarness();
    const existing = seedUser(prisma);

    const response = await auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER });

    expect(response.userId).toBe(existing.id);
    expect(prisma.users.size).toBe(1);
    expect(prisma.calls).not.toContain('create');
    // The new code is issued for the same user, and `OtpService.issue` invalidates
    // the previous one in the same transaction.
    expect(otp.issued).toEqual([existing.id]);
    expect(notifications.sent).toHaveLength(1);
  });

  /**
   * Step 32's registration entry, and the reason it is written *before* the code is issued and the
   * SMS sent: by that line the row exists with this handle, and that fact does not become untrue
   * because the provider was down. The other half of the assertion is `source`, which is what makes
   * the trail readable - and the middle call is why that matters: a handle changed on a resend is
   * two entries with two different values for one user id, which is exactly the history an
   * append-only table is for.
   */
  it('appends user.handle.set, naming the row and how the handle was claimed', async () => {
    const { auth, prisma, audit } = createHarness();
    // Drawn from the row the first call creates, so the two later entries point at the same user -
    // which is the claim: one id, three entries, and a `source` that says which was which.
    const number = LOCAL_NUMBER;

    await auth.register({ pin: PIN, phoneNumber: number, handle: 'ama1' });
    const user = prisma.users.get(E164_NUMBER);

    // A mistyped handle, corrected on the resend: allowed by Step 14, and visible here.
    await auth.register({ pin: PIN, phoneNumber: number, handle: 'ama_1' });
    // And a resend that submits nothing: the row's own handle is what the entry carries.
    await auth.register({ pin: PIN, phoneNumber: number });
    // The updates are Prisma's own, so the spec asserts what the entry says rather than what the
    // fake's map holds. Two of them now (Step 34a): the handle change, and the third registration -
    // which submits no handle at all - because the PIN is written with the row on every path.
    expect(prisma.calls.filter((call) => call === 'update')).toHaveLength(2);

    expect(audit.entries).toEqual([
      {
        action: 'user.handle.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { handle: 'ama1', source: 'registration' },
      },
      {
        action: 'auth.pin.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { source: 'registration' },
      },
      {
        action: 'user.handle.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { handle: 'ama_1', source: 'resend' },
      },
      {
        action: 'auth.pin.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { source: 'resend' },
      },
      {
        action: 'user.handle.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { handle: 'ama_1', source: 'resend' },
      },
      {
        action: 'auth.pin.set',
        userId: user?.id,
        outcome: 'ok',
        metadata: { source: 'resend' },
      },
    ]);
    // The row agrees, so the entries are not the only witness.
    expect(user?.handle).toBe('ama_1');
  });

  it('refuses the request past the rate limit with a 429, leaving nothing behind', async () => {
    const { auth, prisma, limiter, otp, notifications } = createHarness();
    limiter.error = new OtpRateLimitExceededError(900);

    const { status, message } = await captureHttpError(() =>
      auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER }),
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

    const { status } = await captureHttpError(() => auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(503);
    // Fail closed, the same way the limiter does: an unanswerable limit means no
    // send, never "assume it is fine".
    expect(notifications.sent).toHaveLength(0);
  });

  it('answers 503 and keeps the pending row when the SMS provider refuses', async () => {
    const { auth, prisma, notifications, audit } = createHarness();
    notifications.error = new SmsDeliveryError('the provider rejected the message');

    const { status } = await captureHttpError(() => auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER }));

    expect(status).toBe(503);
    // The row and the code stay: the account cannot be activated without a code
    // the user never received, and deleting the row would race with a concurrent
    // registration for the same number.
    expect(prisma.users.get(E164_NUMBER)?.status).toBe(UserStatus.PENDING_VERIFICATION);
    // The entries stay too (Step 32), and they are written before the send on purpose: the row above
    // *does* exist with this handle, so the only thing that failed was an SMS. An entry placed after
    // `sendOtp` would claim no handle was ever set when the user retries and finds their account.
    // Step 34a's `auth.pin.set` is written on the same path and for the same reason: the PIN was
    // stored with the row, and a provider outage afterwards does not make that untrue.
    expect(audit.entries).toEqual([
      {
        action: 'user.handle.set',
        userId: 'user-1',
        outcome: 'ok',
        metadata: { handle: null, source: 'registration' },
      },
      {
        action: 'auth.pin.set',
        userId: 'user-1',
        outcome: 'ok',
        metadata: { source: 'registration' },
      },
    ]);
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
      const { auth, prisma, otp, provisioning } = createHarness();
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
      // Nor a wallet: provisioning is the consequence of a *verified* number, so a
      // refused code cannot leave a funded account behind either.
      expect(provisioning.provisioned).toEqual([]);
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

    // Consume and activate are one transaction, in that order. Provisioning happens after
    // it - Step 19, asserted in its own test below - which is why this is the first five
    // entries rather than the whole log.
    expect(prisma.transactionCount).toBe(1);
    expect(prisma.calls.slice(0, 5)).toEqual([
      'findUnique',
      'begin',
      'tx.consume',
      'tx.activate',
      'commit',
    ]);
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

  /**
   * Step 19, and the ordering here is the whole point of the test: `provision` lands
   * *after* `commit` in the shared call log, so the wallet is built once the fact that
   * makes the user a customer is durable - not inside the transaction, where a slow
   * faucet would hold the user's row locks (and where a crash would roll back a
   * verification because a third party was slow).
   */
  it('provisions the wallet for the user it just verified, after the commit', async () => {
    const { auth, prisma, provisioning, audit } = createHarness();
    const user = seedUser(prisma);

    await auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    // The entry is the third thing in that window and its position is the decision (Step 32): after
    // the commit, because verification is durable by then, and *before* provisioning, because an
    // entry that waited on a Horizon round trip would arrive seconds late and an `incomplete` wallet
    // would leave the trail looking as though nothing had been verified.
    expect(prisma.calls).toEqual([
      'findUnique',
      'begin',
      'tx.consume',
      'tx.activate',
      'commit',
      'audit:auth.otp.verified',
      'provision',
    ]);
    expect(audit.entries).toEqual([
      { action: 'auth.otp.verified', userId: user.id, outcome: 'ok' },
    ]);
    // For the id the *database* holds, not the number the client sent: the wallet is
    // attached to a user row, and the number is only what was verified.
    expect(provisioning.provisioned).toEqual([user.id]);
  });

  /**
   * The response is the contract `verifyOtp` has always had, and provisioning cannot
   * change it - because by the time it runs the code has been spent, so a retry cannot
   * succeed and an error would tell a user they failed at the one thing they just did.
   * An `incomplete` outcome is the ordinary shape of that: the account exists and has no
   * wallet yet, and the caller is told the same thing it would have been told otherwise.
   */
  it('answers exactly as before when provisioning comes back incomplete', async () => {
    const { auth, prisma, provisioning } = createHarness();
    const user = seedUser(prisma);
    provisioning.outcome = {
      status: 'incomplete',
      stage: 'funding',
      accountId: 'account-1',
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      detail: 'friendbot answered 503',
    };

    const response = await auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    expect(response.userId).toBe(user.id);
    // The session is still started: the phone number *is* verified, and that is what the
    // tokens are for. Only the wallet is missing, which is a retry for the service.
    expect(response.accessToken).toBe('access-token-1');
    expect(response.refreshToken).toBe('refresh-token-1');
    // And no stage leaks into the body - a client that branched on this would be a
    // client making a decision that belongs to the service.
    expect(JSON.stringify(response)).not.toContain('funding');
  });

  it('accepts a number in any format, because it normalizes before looking it up', async () => {
    const { auth, prisma, otp } = createHarness();
    const user = seedUser(prisma);

    await auth.verifyOtp({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    // `024 123 4567` found the row stored as `+233241234567`.
    expect(otp.checked).toEqual([{ userId: user.id, code: '123456' }]);
  });

  it('refuses a code that was already used, without activating the user', async () => {
    const { auth, prisma, audit } = createHarness();
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
    // Nothing appended either (Step 32): the number was not proved, so `auth.otp.verified` would be
    // a false record - and the code being refused is exactly the case where a false one would be
    // least visible in the table.
    expect(audit.entries).toEqual([]);
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
    const { auth, prisma, otp, tokens, audit } = createHarness();
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
    // nothing about the account, which is the whole difference from verification. Step 32's
    // `auth.login` comes last, after the code is spent (which is what makes it a sign-in rather than
    // a check on a live code) and after the pair is minted, so the row means "a session exists".
    expect(prisma.calls).toEqual(['findUnique', 'consume', 'audit:auth.login']);
    expect(prisma.transactionCount).toBe(0);
    expect(audit.entries).toEqual([{ action: 'auth.login', userId: user.id, outcome: 'ok' }]);
    // `phoneVerifiedAt` records when the *number* was proven; a sign-in that re-stamped it
    // would be a lie about that.
    expect(user.phoneVerifiedAt).toEqual(verifiedAt);

    // The row as it was read, with no in-memory patch - because nothing was written.
    expect(tokens.issued).toEqual([user]);
  });

  /**
   * Sign-in is not a provisioning trigger, and this is the assertion that keeps it that
   * way: a user who can sign in has been verified before, so their wallet already exists
   * (`AccountProvisioningService` answers `already-provisioned` and funds nothing). A
   * sign-in that called it would be a network round trip on the hot path for every
   * returning user, to discover something this flow already knows.
   */
  it('provisions nothing: signing in does not create wallets', async () => {
    const { auth, prisma, tokens, provisioning } = createHarness();
    seedUser(prisma, { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() });

    await auth.login({ phoneNumber: LOCAL_NUMBER, code: '123456' });

    expect(provisioning.provisioned).toEqual([]);
    // Signing in is still an auditable event (Step 32): the wallet is what this test says is absent,
    // not the record of the sign-in.
    expect(prisma.calls).toEqual(['findUnique', 'consume', 'audit:auth.login']);
    expect(tokens.issued).toHaveLength(1);
  });

  it('refuses a code that was already used, and starts no session for it', async () => {
    const { auth, prisma, otp, tokens, audit } = createHarness();
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
    // And no `auth.login` (Step 32): no session exists, so the entry would describe a sign-in that
    // did not happen - the same rule that keeps `auth.otp.verified` off a refused code.
    expect(audit.entries).toEqual([]);
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

describe('AuthService.register and the transaction PIN (Step 34a)', () => {
  it('stores a hash of the PIN with the row, never the PIN', async () => {
    const { auth, prisma } = createHarness();

    await auth.register({ pin: PIN, phoneNumber: LOCAL_NUMBER });

    const stored = prisma.users.get(E164_NUMBER)?.transactionPinHash;

    // The one format `secret-hash.ts` writes. The column is never four digits, which is the whole
    // reason a `char(4)` was refused in the migration.
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain(PIN);
  });

  it('writes the PIN again when an unverified account registers again', async () => {
    const { auth, prisma } = createHarness();
    seedUser(prisma);

    await auth.register({ pin: '4321', phoneNumber: LOCAL_NUMBER });

    // The row is reused and there is still only one; the PIN is written with it, because the code
    // about to be sent is the proof that this is the same person. The alternative - a resend that
    // skipped the write - is an account whose first payment fails for a reason its owner cannot see.
    expect(prisma.users.size).toBe(1);
    expect(prisma.calls).toContain('update');
    expect(prisma.users.get(E164_NUMBER)?.transactionPinHash).not.toBeNull();
  });
});

describe('AuthService.changePin / verifyPin (Step 34a)', () => {
  /** The signed-in caller both endpoints receive, as `JwtStrategy` would have left it. */
  const session: SessionUser = {
    id: 'user-1',
    phoneNumber: E164_NUMBER,
    status: UserStatus.ACTIVE,
    handle: 'ama_1',
  };

  it('answers with when the PIN was written, and passes both PINs through untouched', async () => {
    const { auth, pins } = createHarness();

    const response = await auth.changePin(session, { pin: '1234', currentPin: '4321' });

    expect(pins.changed).toEqual([{ userId: session.id, currentPin: '4321', pin: '1234' }]);
    expect(response.pinSetAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('maps a change with no currentPin to a 409 that names the field', async () => {
    const { auth, pins } = createHarness();
    pins.changeOutcome = { ok: false, reason: 'current_pin_required' };

    const { status, message } = await captureHttpError(() =>
      auth.changePin(session, { pin: '1234' }),
    );

    expect(status).toBe(409);
    expect(message).toContain('currentPin');
  });

  it('maps a wrong current PIN to a 409 that says how many attempts are left', async () => {
    const { auth, pins } = createHarness();
    pins.changeOutcome = { ok: false, reason: 'invalid_pin', attemptsRemaining: 3 };

    const { status, message } = await captureHttpError(() =>
      auth.changePin(session, { pin: '1234', currentPin: '4321' }),
    );

    // A 409 rather than a 401: the access token is fine and the conflict is with the *account's*
    // state. The same outcome is a 401 on the step-up call below, which is why the mapping lives
    // here rather than in `PinService`.
    expect(status).toBe(409);
    expect(message).toContain('3 attempts remaining');
  });

  it('maps a wrong PIN on the step-up call to a 401 that says how many attempts are left', async () => {
    const { auth, pins } = createHarness();
    pins.verifyOutcome = { ok: false, reason: 'invalid_pin', attemptsRemaining: 4 };

    const { status, message } = await captureHttpError(() =>
      auth.verifyPin(session, { pin: '9999' }),
    );

    expect(status).toBe(401);
    expect(message).toContain('4 attempts remaining');
  });

  it('maps a locked PIN to a 429 that says when it can be tried again', async () => {
    const { auth, pins } = createHarness();
    pins.verifyOutcome = {
      ok: false,
      reason: 'locked',
      lockedUntil: new Date('2026-10-02T10:15:00.000Z'),
    };

    const { status, message } = await captureHttpError(() =>
      auth.verifyPin(session, { pin: '1234' }),
    );

    // Waiting is the action, so it is a 429 rather than another refusal - and the message carries
    // the instant, because "try again later" is not something a client can show anyone.
    expect(status).toBe(429);
    expect(message).toContain('2026-10-02T10:15:00.000Z');
  });

  it('maps an account with no PIN to a 409, because nothing was refused', async () => {
    const { auth, pins } = createHarness();
    pins.verifyOutcome = { ok: false, reason: 'not_set' };

    const { status, message } = await captureHttpError(() =>
      auth.verifyPin(session, { pin: '1234' }),
    );

    expect(status).toBe(409);
    expect(message).toContain('No transaction PIN is set');
  });

  it('mints a step-up token for the caller, and answers with nothing else', async () => {
    const { auth, pins, stepUpTokens } = createHarness();

    const response = await auth.verifyPin(session, { pin: '1234' });

    expect(pins.verified).toEqual([{ userId: session.id, pin: '1234' }]);
    // Minted for the caller, not for the token's own sake: the guard compares this against the
    // authenticated user, which is what stops one account's proof authorising another's payment.
    expect(stepUpTokens.issued).toEqual([session.id]);
    expect(response.stepUpToken).toBe('step-up-token-1');
    expect(response.stepUpTokenExpiresAt).toBe('2026-10-02T10:05:00.000Z');
    expect(Object.keys(response).sort()).toEqual(['stepUpToken', 'stepUpTokenExpiresAt']);
  });

  it('never puts the PIN in a refusal message', async () => {
    const { auth, pins } = createHarness();
    pins.verifyOutcome = { ok: false, reason: 'invalid_pin', attemptsRemaining: 4 };

    const { message } = await captureHttpError(() => auth.verifyPin(session, { pin: '9999' }));

    expect(message).not.toContain('9999');
    expect(message).not.toContain('1234');
  });
});

/**
 * The identifier half of the password sign-in (Steps 34b and 34c).
 *
 * The *flow* - set, change, reset, and the single 401 - is asserted over real HTTP in
 * `test/password.e2e-spec.ts`, because it is mostly about rows and codes. What is asserted here is
 * the decision this file exists for and that a running database would hide: *which* identifier the
 * request was about. Every use of it has to agree - the column that is looked up, the subject the
 * attempt is counted against, and the mask the log line carries - so these tests are largely about
 * those three moving together, and about the refusals that must land before any of them is reached.
 */
describe('AuthService.loginWithPassword (Steps 34b and 34c)', () => {
  /** An address the way `POST /auth/email` stores it, and another spelling of the same mailbox. */
  const STORED_EMAIL = 'miriam@example.com';
  const SUBMITTED_EMAIL = '  Miriam@Example.COM  ';
  /** Masks, asserted exactly: they are the only spelling of an identifier a log line may carry. */
  const EMAIL_MASK = 'm***@example.com';
  const PHONE_MASK = '+233*****4567';

  const PASSWORD = 'correct horse battery staple';

  it('refuses a body with both identifiers, before anything is looked up, counted or written', async () => {
    const { auth, prisma, limiter, audit, tokens } = createHarness();
    seedUser(prisma, {
      status: UserStatus.ACTIVE,
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({
        phoneNumber: LOCAL_NUMBER,
        email: STORED_EMAIL,
        password: PASSWORD,
      }),
    );

    expect(status).toBe(400);
    // It names the pair rather than one field, because the body is wrong only as a whole.
    expect(message).toContain('not both');
    // Nothing was decided about an account, so there is nothing read, counted, minted or recorded -
    // which is also why this 400 cannot be used to spend anyone's allowance.
    expect(prisma.calls).toEqual([]);
    expect(limiter.consumed).toEqual([]);
    expect(tokens.issued).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it('refuses a body with neither identifier, and says what to send', async () => {
    const { auth, prisma, limiter } = createHarness();

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({ password: PASSWORD }),
    );

    expect(status).toBe(400);
    expect(message).toContain('phone number or the email address');
    expect(prisma.calls).toEqual([]);
    expect(limiter.consumed).toEqual([]);
  });

  it('signs in the account a verified address belongs to, looked up by the address alone', async () => {
    const { auth, prisma, limiter, tokens, audit, passwords } = createHarness();
    const user = seedUser(prisma, {
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    const response = await auth.loginWithPassword({ email: SUBMITTED_EMAIL, password: PASSWORD });

    expect(response.userId).toBe(user.id);
    // One indexed read of the column the identifier names, then the entry recording the sign-in: no
    // scan across both columns, no second lookup.
    expect(prisma.calls).toEqual(['findUnique', 'audit:auth.password.login']);
    // `  Miriam@Example.COM  ` found the row stored as `miriam@example.com`: the value looked up is
    // the normalized one, which is the value `EmailService` wrote, so the unique index does the work.
    expect(limiter.consumed).toEqual([STORED_EMAIL]);
    // Counted against the *address*, and handed the mail mask rather than the address itself: this is
    // the assertion that fails if the two halves of `SignInIdentifier` ever drift apart.
    expect(limiter.masks).toEqual([EMAIL_MASK]);
    expect(passwords.verified).toEqual([{ userId: user.id, password: PASSWORD }]);
    expect(response.accessToken).toBe('access-token-1');
    // The account's own number, not the submitted identifier: an address is a second way to present
    // the credential, and the account still has exactly one number.
    expect(response.phoneNumber).toBe(E164_NUMBER);
    expect(response.status).toBe(UserStatus.ACTIVE);
    expect(audit.entries).toEqual([
      { action: 'auth.password.login', userId: user.id, outcome: 'ok' },
    ]);
    expect(tokens.issued).toEqual([user]);
  });

  it('answers one 401 for an address that is attached but never proved, without checking the password', async () => {
    const { auth, prisma, passwords, tokens, audit } = createHarness();
    const user = seedUser(prisma, {
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      email: STORED_EMAIL,
      emailVerifiedAt: null,
    });

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD }),
    );

    expect(status).toBe(401);
    // The same sentence an unknown address gets (below): this endpoint must not be a way of learning
    // which addresses are claimed, or which claimed ones were never proved.
    expect(message).toContain('do not match');
    // scrypt never ran, and that is the decision rather than an optimization: an unproved address is
    // not a credential, so whatever password hangs off it is not worth checking.
    expect(passwords.verified).toEqual([]);
    expect(tokens.issued).toEqual([]);
    // Which of the several reasons it was is recorded for the operator - and it is `denied`, like
    // every other refusal here, because the client was not told.
    expect(audit.entries).toEqual([
      { action: 'auth.password.login', userId: user.id, outcome: 'denied' },
    ]);
  });

  it('answers the same 401 for an address nothing holds, and records it against no account', async () => {
    const { auth, limiter, audit, passwords, tokens } = createHarness();

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD }),
    );

    expect(status).toBe(401);
    expect(message).toContain('do not match');
    // Counted anyway. A limiter that only counted addresses that exist would let an attacker probe
    // for which ones do at full speed, which is the enumeration this step is trying to prevent.
    expect(limiter.consumed).toEqual([STORED_EMAIL]);
    expect(limiter.masks).toEqual([EMAIL_MASK]);
    expect(passwords.verified).toEqual([]);
    expect(tokens.issued).toEqual([]);
    // No account to attribute it to, so the row carries no `userId` rather than a guessed one.
    expect(audit.entries).toEqual([
      { action: 'auth.password.login', userId: undefined, outcome: 'denied' },
    ]);
  });

  it('refuses a suspended account with a 403 before its allowance is touched', async () => {
    const { auth, prisma, limiter, audit, tokens } = createHarness();
    seedUser(prisma, {
      status: UserStatus.SUSPENDED,
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    const { status } = await captureHttpError(() =>
      auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD }),
    );

    expect(status).toBe(403);
    // The order matters and is the reason this test exists: the account is looked up first, so a
    // suspended account cannot have its own counter spent by anyone else, and the refusal is final
    // whatever the password was. Nothing was written, because nothing was refused *at* the caller.
    expect(prisma.calls).toEqual(['findUnique']);
    expect(limiter.consumed).toEqual([]);
    expect(tokens.issued).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it('counts the number and the address on one account separately, as two identifiers', async () => {
    const { auth, prisma, limiter } = createHarness();
    seedUser(prisma, {
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    await auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD });
    await auth.loginWithPassword({ phoneNumber: LOCAL_NUMBER, password: PASSWORD });

    // The subject is the identifier as submitted - the address for the first call, the E.164 number
    // for the second - and each carries its own mask. One counter for the pair would mean guesses at
    // whichever identifier is cheaper to try could lock the other one out.
    expect(limiter.consumed).toEqual([STORED_EMAIL, E164_NUMBER]);
    expect(limiter.masks).toEqual([EMAIL_MASK, PHONE_MASK]);
  });

  it('maps an exhausted allowance on an address to a 429, and never reaches scrypt', async () => {
    const { auth, prisma, limiter, audit, tokens, passwords } = createHarness();
    seedUser(prisma, {
      status: UserStatus.ACTIVE,
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    limiter.error = new OtpRateLimitExceededError(900);

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD }),
    );

    expect(status).toBe(429);
    // Wording for a *sign-in*, not for a code request: the counter is shared but the caller is not,
    // and a person who has been guessing passwords is not told about verification codes.
    expect(message).toContain('Too many sign-in attempts');
    expect(message).toContain('15 minutes');
    // The refusal happens before the credential is checked, so a blocked attempt costs no scrypt
    // work, mints nothing, and is not recorded against the account as a failed sign-in.
    expect(passwords.verified).toEqual([]);
    expect(tokens.issued).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it('maps an unavailable limiter to a 503, rather than letting a sign-in through unchecked', async () => {
    const { auth, prisma, limiter, passwords, tokens } = createHarness();
    seedUser(prisma, {
      status: UserStatus.ACTIVE,
      email: STORED_EMAIL,
      emailVerifiedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    limiter.error = new OtpRateLimitUnavailableError();

    const { status, message } = await captureHttpError(() =>
      auth.loginWithPassword({ email: STORED_EMAIL, password: PASSWORD }),
    );

    // Redis being down must not read as "no limit": refusing is the safe failure, and it is the same
    // answer the OTP paths give, so nobody can take sign-in down to remove the cap.
    expect(status).toBe(503);
    expect(message).toContain('temporarily unavailable');
    expect(passwords.verified).toEqual([]);
    expect(tokens.issued).toEqual([]);
  });
});
