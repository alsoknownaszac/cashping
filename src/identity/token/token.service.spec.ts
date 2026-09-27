import { type ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_MINUTES, REFRESH_TOKEN_TTL_DAYS } from '../../config/configuration.js';
import { UserStatus } from '../../generated/prisma/enums.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from '../jwt/access-token.js';
import { generateRefreshToken, hashRefreshToken, looksLikeRefreshToken } from './refresh-token.js';
import { TokenService, type SessionUser } from './token.service.js';

/**
 * The session rules of Step 16, asserted against a fake `refreshToken` table and a
 * real `JwtService`: the digest is the only thing written, a refresh token is
 * single-use, a replayed one retires the whole family, and a logout is idempotent.
 *
 * The signing half is deliberately *not* faked. `JwtModule` signs with
 * `expiresIn: auth.accessTokenTtlMinutes * 60` while `TokenService` reports
 * `accessTokenExpiresAt` from the same key, and the test that decodes a real token
 * is what keeps those two expressions of one number from drifting apart - a
 * mismatch there is a client that refreshes at the wrong moment, and it is
 * invisible to a fake that returns a canned string.
 *
 * `refresh-token.spec.ts` covers the three pure functions (generation, digest,
 * shape); this file covers what the service does with them.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SECONDS_PER_MINUTE = 60;

/** The lifetimes `configuration()` supplies: the same numbers the module signs with. */
const TOKEN_CONFIG: Readonly<Record<string, number>> = {
  'auth.accessTokenTtlMinutes': ACCESS_TOKEN_TTL_MINUTES,
  'auth.refreshTokenTtlDays': REFRESH_TOKEN_TTL_DAYS,
};

function createConfig(): ConfigService {
  return { getOrThrow: (key: string) => TOKEN_CONFIG[key] } as unknown as ConfigService;
}

/** Long enough for the HS256 secret `validation.schema.ts` insists on. */
const JWT_SECRET = 'token-service-spec-secret-long-enough';

/** The signing options `JwtModule` is registered with (see `identity.module.ts`). */
const JWT_SIGN_OPTIONS = {
  expiresIn: ACCESS_TOKEN_TTL_MINUTES * SECONDS_PER_MINUTE,
  algorithm: ACCESS_TOKEN_ALGORITHM,
  issuer: ACCESS_TOKEN_ISSUER,
  audience: ACCESS_TOKEN_AUDIENCE,
} as const;

/** A fixed clock, so every expiry in this file is an exact instant. */
const NOW = new Date('2026-09-26T10:04:12.000Z');

/** A UUID, because that is what `sub` carries and what `JwtStrategy` checks. */
const USER_ID = '9b2f1d6e-0c3a-4f57-8a1b-2c4d5e6f7a80';

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: USER_ID,
    phoneNumber: '+233241234567',
    status: UserStatus.ACTIVE,
    handle: 'miriam_owusu',
    ...overrides,
  };
}

interface FakeRefreshRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * The `refresh_tokens` table, in memory (plus the `user` a `findUnique` joins).
 *
 * `where` is matched field-by-field, so the filter the service writes is what the
 * tests exercise rather than what the fake assumes: dropping `revokedAt: null`
 * from `rotate` or `revoke` would start matching retired rows and fail here.
 *
 * Rows seeded by a test are not recorded in `calls` - the trace is the *service's*
 * work, which is what the ordering assertions read.
 */
class FakePrisma {
  readonly rows: FakeRefreshRow[] = [];
  readonly calls: string[] = [];

  /** Set to make `create` fail: the "nothing was handed out" test. */
  failCreate: Error | null = null;

  /** Set to make `updateMany` report a given count: the lost-race test. */
  updateCount: number | null = null;

  private readonly users = new Map<string, SessionUser>();

  private nextId = 1;

  readonly refreshToken = {
    create: async (args: {
      data: { userId: string; tokenHash: string; expiresAt: Date };
    }): Promise<FakeRefreshRow> => {
      this.calls.push('create');

      if (this.failCreate !== null) {
        throw this.failCreate;
      }

      return this.insert(args.data);
    },

    findUnique: async (args: {
      where: { tokenHash: string };
      include?: unknown;
    }): Promise<(FakeRefreshRow & { user?: SessionUser }) | null> => {
      this.calls.push('findUnique');

      const row = this.rows.find((candidate) => candidate.tokenHash === args.where.tokenHash);

      if (row === undefined) {
        return null;
      }

      if (args.include === undefined) {
        return row;
      }

      const user = this.users.get(row.userId);

      if (user === undefined) {
        throw new Error(`no user seeded for ${row.userId}`);
      }

      return { ...row, user };
    },

    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Partial<FakeRefreshRow>;
    }): Promise<{ count: number }> => {
      this.calls.push('updateMany');

      if (this.updateCount !== null) {
        return { count: this.updateCount };
      }

      return { count: this.patch(args.where, args.data) };
    },
  };

  /** Records the owner of a session, so a join has something to return. */
  seedUser(user: SessionUser): void {
    this.users.set(user.id, user);
  }

  /** Adds a row the way an earlier request would have. */
  insert(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt?: Date | null;
  }): FakeRefreshRow {
    const row: FakeRefreshRow = {
      id: `refresh-${this.nextId++}`,
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: data.revokedAt ?? null,
      createdAt: new Date(),
    };

    this.rows.push(row);

    return row;
  }

  /** The rows of `userId` that are still live, in insertion order. */
  liveRows(userId = USER_ID): FakeRefreshRow[] {
    return this.rows.filter((row) => row.userId === userId && row.revokedAt === null);
  }

  private patch(where: Record<string, unknown>, data: Partial<FakeRefreshRow>): number {
    let matched = 0;

    for (const row of this.rows) {
      if (!this.matches(row, where)) {
        continue;
      }

      Object.assign(row, data);
      matched += 1;
    }

    return matched;
  }

  private matches(row: FakeRefreshRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(
      ([key, value]) => row[key as keyof FakeRefreshRow] === value,
    );
  }
}

/**
 * The service under test, with the `JwtService` it signs through recorded.
 *
 * `TokenService` calls exactly one method on it, so the recording object is that
 * method and nothing else - the shape a fake can have only when the dependency is
 * this narrow. `verifier` is a separate, *unfaked* `JwtService` holding the same
 * secret and options: the way `JwtStrategy` will read what `issue` signed.
 */
function createHarness() {
  const prisma = new FakePrisma();
  const signed: Array<Record<string, unknown>> = [];
  const realJwt = new JwtService({ secret: JWT_SECRET, signOptions: JWT_SIGN_OPTIONS });

  const jwt = {
    signAsync: async (payload: Record<string, unknown>): Promise<string> => {
      signed.push({ ...payload });

      return realJwt.signAsync(payload);
    },
  } as unknown as JwtService;

  return {
    service: new TokenService(prisma as unknown as PrismaService, jwt, createConfig()),
    prisma,
    signed,
    verifier: new JwtService({ secret: JWT_SECRET, signOptions: JWT_SIGN_OPTIONS }),
  };
}

/** A live session for `user`, as an earlier `issue` would have left it. */
function storedSession(
  prisma: FakePrisma,
  user: SessionUser,
  options: { token?: string; expiresAt?: Date; revokedAt?: Date | null } = {},
): { token: string; id: string } {
  const token = options.token ?? generateRefreshToken();

  prisma.seedUser(user);

  const row = prisma.insert({
    userId: user.id,
    tokenHash: hashRefreshToken(token),
    expiresAt: options.expiresAt ?? new Date(NOW.getTime() + REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    revokedAt: options.revokedAt ?? null,
  });

  return { token, id: row.id };
}

describe('TokenService.issue', () => {
  it('stores the digest of the refresh token and hands the plaintext back once', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const issued = await service.issue(user, NOW);

    expect(prisma.calls).toEqual(['create']);
    // The token the caller holds is the value a CSPRNG produced, exactly as
    // `refresh-token.spec.ts` describes it...
    expect(looksLikeRefreshToken(issued.refreshToken)).toBe(true);
    // ...and what the row holds is its digest, so a dump of this table contains no
    // session anyone can present.
    expect(prisma.rows[0]?.tokenHash).toBe(hashRefreshToken(issued.refreshToken));
    expect(prisma.rows[0]?.tokenHash).not.toBe(issued.refreshToken);
    expect(prisma.rows[0]?.userId).toBe(user.id);
    expect(prisma.rows[0]?.revokedAt).toBeNull();
  });

  it('writes nothing before it mints, so a failed write leaves no session behind', async () => {
    const { service, prisma, signed } = createHarness();
    prisma.failCreate = new Error('the database is unreachable');

    await expect(service.issue(sessionUser(), NOW)).rejects.toThrow('the database is unreachable');

    // The ordering `issue` documents: the row first, the signature second. The other
    // way round the caller would hold a working access token for a session that was
    // never recorded - it cannot be refreshed, cannot be logged out, and dies in 15
    // minutes with nothing to explain why.
    expect(prisma.calls).toEqual(['create']);
    expect(signed).toEqual([]);
  });

  it('resolves both expiries from the configured lifetimes, off the clock it is given', async () => {
    const { service } = createHarness();

    const issued = await service.issue(sessionUser(), NOW);

    expect(issued.accessTokenExpiresAt.getTime()).toBe(
      NOW.getTime() + ACCESS_TOKEN_TTL_MINUTES * MINUTE_MS,
    );
    expect(issued.refreshExpiresAt.getTime()).toBe(NOW.getTime() + REFRESH_TOKEN_TTL_DAYS * DAY_MS);
  });

  it('signs an access token carrying only `sub`, under the contract the module signs with', async () => {
    const { service, verifier, signed } = createHarness();
    const user = sessionUser();

    // Signed off the real clock, not the fixed `NOW`, because `jsonwebtoken` stamps
    // `iat`/`exp` from the wall clock: the assertion below is about the *lifetime*, so
    // the response's expiry has to be computed from the same instant the signature was.
    const issued = await service.issue(user);
    const claims = await verifier.verifyAsync<Record<string, unknown>>(issued.accessToken);

    // Verified with the same secret and the same issuer/audience/algorithm the API
    // signs with: a token signed under a different contract is one `JwtStrategy`
    // would reject, and the mismatch would otherwise only show up in production.
    expect(claims.sub).toBe(user.id);
    expect(claims.iss).toBe(ACCESS_TOKEN_ISSUER);
    expect(claims.aud).toBe(ACCESS_TOKEN_AUDIENCE);
    // Nothing else is signed on purpose: `handle`, `status` and `phoneNumber` would be
    // a cached copy of a database row, and a stale copy is a second, quieter source of
    // truth for authorisation. `JwtStrategy` reads those from the row instead.
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
    expect(signed).toEqual([{ sub: user.id }]);

    /**
     * The claim of this test: the lifetime inside the token and the lifetime reported
     * in the response body are the same number, spelled once
     * (`auth.accessTokenTtlMinutes`). `exp - iat` is exact; `accessTokenExpiresAt` is
     * compared with a one-second tolerance because it is computed in milliseconds while
     * `jsonwebtoken` truncates `iat` to whole seconds.
     */
    expect((claims.exp as number) - (claims.iat as number)).toBe(
      ACCESS_TOKEN_TTL_MINUTES * SECONDS_PER_MINUTE,
    );
    expect(
      Math.abs((claims.exp as number) * 1_000 - issued.accessTokenExpiresAt.getTime()),
    ).toBeLessThanOrEqual(1_000);
  });

  it('gives a second sign-in from the same number its own row, so revoking one spares the other', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const first = await service.issue(user, NOW);
    const second = await service.issue(user, NOW);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(prisma.rows).toHaveLength(2);
    expect(prisma.rows.map((row) => row.userId)).toEqual([user.id, user.id]);
    // Two rows, two digests: a phone and a laptop are two sessions, and signing out on
    // one must not sign out the other.
    expect(new Set(prisma.rows.map((row) => row.tokenHash)).size).toBe(2);
  });
});

/** A generic refusal: the one wording every non-reuse failure of `rotate` gets. */
const INVALID_REFRESH_TOKEN = 'Invalid or expired refresh token. Sign in again.';

/** The status and message of the Nest exception a call throws, for refusal tests. */
async function captureHttpError(
  work: () => Promise<unknown>,
): Promise<{ status: number; message: string }> {
  try {
    await work();
  } catch (error) {
    const refusal = error as { getStatus?: () => number; message?: string };

    if (typeof refusal.getStatus !== 'function') {
      throw error;
    }

    return { status: refusal.getStatus(), message: refusal.message ?? '' };
  }

  throw new Error('expected the call to be refused, but it resolved');
}

describe('TokenService.rotate', () => {
  it('refuses a value that could not be one of ours without touching the database', async () => {
    const { service, prisma } = createHarness();

    const { status, message } = await captureHttpError(() => service.rotate('not-a-token', NOW));

    expect(status).toBe(401);
    expect(message).toBe(INVALID_REFRESH_TOKEN);
    // Shape first: an empty string or an access token pasted into the wrong field never
    // reaches a query, and every malformed value gets the same answer as a revoked one.
    expect(prisma.calls).toEqual([]);
    expect(prisma.rows).toEqual([]);
  });

  it('answers an unknown token exactly like an expired one, so there is no oracle', async () => {
    const unknown = createHarness();
    const expired = createHarness();
    const user = sessionUser();

    // A token this API never issued, and a real one that has run out: both are "this
    // credential does not work", and a message that told them apart would let an
    // attacker confirm that a guessed digest exists.
    const neverIssued = await captureHttpError(() =>
      unknown.service.rotate(generateRefreshToken(), NOW),
    );
    const { token } = storedSession(expired.prisma, user, {
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const ranOut = await captureHttpError(() => expired.service.rotate(token, NOW));

    expect(neverIssued.status).toBe(401);
    expect(ranOut.status).toBe(401);
    expect(neverIssued.message).toBe(ranOut.message);
    expect(neverIssued.message).toBe(INVALID_REFRESH_TOKEN);
    expect(expired.prisma.calls).toEqual(['findUnique']);
  });

  it('treats a spent token as a compromise and retires every session the user has', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();
    const otherUser = sessionUser({
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      phoneNumber: '+233201234567',
    });

    const spent = storedSession(prisma, user, { revokedAt: new Date(NOW.getTime() - 60_000) });
    const laptop = storedSession(prisma, user);
    const stranger = storedSession(prisma, otherUser);

    const { status, message } = await captureHttpError(() => service.rotate(spent.token, NOW));

    expect(status).toBe(401);
    expect(message).toContain('security reasons');
    // Revoke, *then* throw: the caller must not be told "sign in again" while other
    // sessions - possibly the thief's - are still live. And nothing new is issued.
    expect(prisma.calls).toEqual(['findUnique', 'updateMany']);
    expect(prisma.liveRows(user.id)).toEqual([]);
    expect(prisma.rows.find((row) => row.id === laptop.id)?.revokedAt).toEqual(NOW);
    // Only that user's sessions: one person's replayed token is not evidence about
    // another person's.
    expect(prisma.rows.find((row) => row.id === stranger.id)?.revokedAt).toBeNull();
  });

  it('treats an expired token as an ordinary refusal and spares the other sessions', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const ranOut = storedSession(prisma, user, { expiresAt: new Date(NOW.getTime() - 1) });
    const laptop = storedSession(prisma, user);

    const { status, message } = await captureHttpError(() => service.rotate(ranOut.token, NOW));

    expect(status).toBe(401);
    expect(message).toBe(INVALID_REFRESH_TOKEN);
    expect(prisma.calls).toEqual(['findUnique']);
    // Expiry is not reuse. The row is not evidence of anything, and stamping a
    // revocation on it would record a session as "ended" that simply ran out - which is
    // exactly the distinction the family revoke exists to preserve.
    expect(prisma.rows.find((row) => row.id === laptop.id)?.revokedAt).toBeNull();
  });

  it('refuses a suspended account before it can renew, without spending the token', async () => {
    const { service, prisma } = createHarness();
    const suspended = storedSession(prisma, sessionUser({ status: UserStatus.SUSPENDED }));

    const { status, message } = await captureHttpError(() => service.rotate(suspended.token, NOW));

    expect(status).toBe(403);
    expect(message).toContain('suspended');
    expect(prisma.calls).toEqual(['findUnique']);
    // The refusal is the account, not the credential: the token is left live, so
    // lifting a suspension restores the session instead of forcing a fresh sign-in.
    expect(prisma.rows[0]?.revokedAt).toBeNull();
  });

  it('spends the presented token and issues a fresh pair for the same user', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const presented = storedSession(prisma, user);
    const issued = await service.rotate(presented.token, NOW);

    // Revoke first, then issue - see `rotate`: the filter on `revokedAt: null` is what
    // makes two simultaneous refreshes deterministic.
    expect(prisma.calls).toEqual(['findUnique', 'updateMany', 'create']);
    expect(prisma.rows.find((row) => row.id === presented.id)?.revokedAt).toEqual(NOW);
    expect(prisma.rows).toHaveLength(2);
    expect(prisma.rows[1]?.userId).toBe(user.id);
    expect(prisma.rows[1]?.tokenHash).toBe(hashRefreshToken(issued.refreshToken));
    // A different value, so the presented one is worthless from here on.
    expect(issued.refreshToken).not.toBe(presented.token);
    expect(issued.refreshExpiresAt.getTime()).toBe(NOW.getTime() + REFRESH_TOKEN_TTL_DAYS * DAY_MS);
    expect(prisma.liveRows(user.id)).toHaveLength(1);

    // ...and the new token is the one that works now: rotation chains rather than
    // issuing a second parallel session.
    const next = await service.rotate(issued.refreshToken, NOW);

    expect(next.refreshToken).not.toBe(issued.refreshToken);
    expect(prisma.liveRows(user.id)).toHaveLength(1);
  });

  it('turns the loser of simultaneous refreshes into a 401 instead of a second live session', async () => {
    const { service, prisma } = createHarness();
    const presented = storedSession(prisma, sessionUser());

    // What the losing request sees: it read a live row, and by the time it wrote, the
    // winning request had already revoked it - so its update matches nothing.
    prisma.updateCount = 0;

    const { status, message } = await captureHttpError(() => service.rotate(presented.token, NOW));

    expect(status).toBe(401);
    expect(message).toBe(INVALID_REFRESH_TOKEN);
    // No second row: a session nobody holds is still a session, and issuing before
    // revoking is what would create one here.
    expect(prisma.calls).toEqual(['findUnique', 'updateMany']);
    expect(prisma.rows).toHaveLength(1);
  });

  it('retires the family when the token that was rotated away comes back', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const stolen = storedSession(prisma, user);
    // The thief uses it: the token is spent and a new one issued to *them*.
    const theirs = await service.rotate(stolen.token, NOW);

    // The real client refreshes with what it still holds - and this is the moment the
    // theft becomes visible.
    const laptop = storedSession(prisma, user);
    const { status, message } = await captureHttpError(() => service.rotate(stolen.token, NOW));

    expect(status).toBe(401);
    expect(message).toContain('security reasons');
    // Everything goes: the session the thief was handed, and the honest client's other
    // device. Bounding the damage is the point of rotation - without it, a stolen
    // token is a month-long back door.
    expect(prisma.liveRows(user.id)).toEqual([]);
    expect(
      prisma.rows.find((row) => row.tokenHash === hashRefreshToken(theirs.refreshToken))?.revokedAt,
    ).toEqual(NOW);
    expect(prisma.rows.find((row) => row.id === laptop.id)?.revokedAt).toEqual(NOW);
  });
});

describe('TokenService.revoke', () => {
  it('answers false for a value it could not have issued, without a query', async () => {
    const { service, prisma } = createHarness();

    await expect(service.revoke('an-access-token-pasted-here-by-mistake', NOW)).resolves.toBe(
      false,
    );

    expect(prisma.calls).toEqual([]);
  });

  it('retires a live token by its digest and answers true', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();

    const presented = storedSession(prisma, user);
    const otherDevice = storedSession(prisma, user);

    await expect(service.revoke(presented.token, NOW)).resolves.toBe(true);

    expect(prisma.rows.find((row) => row.id === presented.id)?.revokedAt).toEqual(NOW);
    // One session ends at a time here: `revokeAllForUser` is what a *compromise*
    // calls, and a logout is not one.
    expect(prisma.rows.find((row) => row.id === otherDevice.id)?.revokedAt).toBeNull();
    expect(prisma.liveRows(user.id)).toHaveLength(1);
  });

  it('answers false for a token that was already retired, rather than throwing', async () => {
    const { service, prisma } = createHarness();
    const endedAt = new Date(NOW.getTime() - 3_600_000);
    const { token } = storedSession(prisma, sessionUser(), { revokedAt: endedAt });

    // A client that logs out twice gets the same empty answer (see
    // `AuthService.logout`): the session is gone either way, and a 401 would leave the
    // client on a "logout failed" screen with nothing useful to do about it.
    await expect(service.revoke(token, NOW)).resolves.toBe(false);

    expect(prisma.calls).toEqual(['updateMany']);
    // The original timestamp stands: it is when the session actually ended.
    expect(prisma.rows[0]?.revokedAt).toEqual(endedAt);
  });
});

describe('TokenService.revokeAllForUser', () => {
  it('retires one user’s live tokens, reports how many, and keeps the old timestamps', async () => {
    const { service, prisma } = createHarness();
    const user = sessionUser();
    const otherUser = sessionUser({
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      phoneNumber: '+233201234567',
    });
    const endedAt = new Date(NOW.getTime() - DAY_MS);

    const oldSession = storedSession(prisma, user, { revokedAt: endedAt });
    const phone = storedSession(prisma, user);
    const laptop = storedSession(prisma, user);
    const stranger = storedSession(prisma, otherUser);

    await expect(service.revokeAllForUser(user.id, NOW)).resolves.toBe(2);

    expect(prisma.calls).toEqual(['updateMany']);
    expect(prisma.liveRows(user.id)).toEqual([]);
    expect(prisma.rows.find((row) => row.id === phone.id)?.revokedAt).toEqual(NOW);
    expect(prisma.rows.find((row) => row.id === laptop.id)?.revokedAt).toEqual(NOW);
    // `revokedAt: null` in the filter rather than a blanket update: re-stamping the rows
    // that had already ended would destroy the only record of when they did.
    expect(prisma.rows.find((row) => row.id === oldSession.id)?.revokedAt).toEqual(endedAt);
    expect(prisma.rows.find((row) => row.id === stranger.id)?.revokedAt).toBeNull();
  });

  it('reports zero for a user with nothing live, leaving the rows untouched', async () => {
    const { service, prisma } = createHarness();
    const endedAt = new Date(NOW.getTime() - 60_000);
    const ended = storedSession(prisma, sessionUser(), { revokedAt: endedAt });

    await expect(service.revokeAllForUser(USER_ID, NOW)).resolves.toBe(0);

    expect(prisma.rows.find((row) => row.id === ended.id)?.revokedAt).toEqual(endedAt);
  });
});
