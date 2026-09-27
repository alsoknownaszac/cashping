import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '../../generated/prisma/enums.js';
import { type UserModel } from '../../generated/prisma/models.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateRefreshToken, hashRefreshToken, looksLikeRefreshToken } from './refresh-token.js';

/**
 * The columns of a user that a session needs.
 *
 * A `Pick` rather than the whole model so that the strategy, the service and the
 * controller can all speak about "the signed-in user" without any of them depending
 * on columns they never read.
 */
export type SessionUser = Pick<UserModel, 'id' | 'phoneNumber' | 'status' | 'handle'>;

/** A freshly issued pair, with the expiry of each half resolved to a Date. */
export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/**
 * One message for every way a refresh token can fail.
 *
 * Deliberately identical for "never existed", "expired", "revoked by a newer
 * refresh" and "malformed": the caller is anonymous, and a message that distinguishes
 * them turns the endpoint into an oracle that a brute-force can read. The one case
 * that gets its own wording is reuse detection, because there the client is being
 * asked to do something specific - sign in again - and a generic message would just
 * produce a support ticket.
 */
const INVALID_REFRESH_TOKEN = 'Invalid or expired refresh token. Sign in again.';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Issues, rotates and revokes the two halves of a session (Step 16).
 *
 * The asymmetry between the pair is the whole design, and it lives here rather than
 * in the controller: an access token is signed and never stored, so nothing can
 * withdraw it before its 15 minutes are up; a refresh token is stored and never
 * trusted on its own signature, so it can be retired at any moment. That is why
 * `rotate` is a database operation and not a signature check.
 *
 * The access token carries `sub` and nothing else. Extra claims (`handle`, `status`,
 * `role`) would be cheap to add and would be stale the moment the row changed - and
 * they would be a second, quieter source of truth for authorisation. Anything beyond
 * "which user is this" is read from the database by `JwtStrategy`, once per request,
 * which is also what makes a suspension take effect immediately rather than when the
 * token happens to expire.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Starts a session: one access token, one stored refresh token.
   *
   * The refresh token is stored *before* the access token is returned, so a failure
   * to write leaves the caller with nothing rather than with a working access token
   * and no way to renew it - the state that produces "the app logs me out every 15
   * minutes" bug reports.
   *
   * Every call creates a row, including a second sign-in from the same phone: two
   * devices are two sessions, and revoking one must not revoke the other.
   */
  async issue(user: SessionUser, now: Date = new Date()): Promise<IssuedTokens> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = this.refreshExpiry(now);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        // The token itself never reaches the database - only its digest. See
        // `hashRefreshToken` for why the digest is unsalted SHA-256.
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });

    return {
      accessToken: await this.signAccessToken(user),
      accessTokenExpiresAt: this.accessExpiry(now),
      refreshToken,
      refreshExpiresAt,
    };
  }

  /**
   * Exchanges a refresh token for a new pair, and retires the one presented.
   *
   * Rotation is what bounds the damage of a stolen refresh token: it is usable once,
   * and using it hands the thief a value that the legitimate client will not have -
   * so the next time the *real* client refreshes, the stale token is presented after
   * the thief's rotated it, reuse is detected, and the whole set of sessions for that
   * user is retired. Without rotation a stolen refresh token is a permanent back door
   * until it expires; with it, the theft is loud and self-limiting.
   *
   * The checks run in this order on purpose:
   *   1. shape, before a hash or a query - junk never reaches the database;
   *   2. existence - unknown token, same answer as every other failure;
   *   3. *already revoked* - this is the replay, and it is treated as a compromise;
   *   4. expiry, so an expired token is not reported as a compromise;
   *   5. account status, so a suspended user cannot renew their way out.
   */
  async rotate(presented: string, now: Date = new Date()): Promise<IssuedTokens> {
    if (!looksLikeRefreshToken(presented)) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(presented) },
      include: {
        user: { select: { id: true, phoneNumber: true, status: true, handle: true } },
      },
    });

    if (stored === null) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    if (stored.revokedAt !== null) {
      /**
       * The token was already spent. Two explanations, and both are treated as
       * compromise: a stolen copy is being replayed, or the client kept a value it
       * should have replaced. Either way the value is out of our control, so every
       * *other* live token for this user is retired as well - logging the user out of
       * their other devices is the safe direction, and the alternative is leaving a
       * thief with a working session while the honest client 401s forever.
       *
       * The revoke happens before the throw: if it failed, the caller must not learn
       * a 401 that suggests everything is fine.
       */
      const retired = await this.revokeAllForUser(stored.userId, now);

      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; ${retired} live token(s) revoked`,
      );

      throw new UnauthorizedException(
        'This session was ended for security reasons. Sign in again.',
      );
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    if (stored.user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = this.refreshExpiry(now);

    /**
     * Revoke first, then issue - never the other way round.
     *
     * `revokedAt: null` in the filter is what makes two simultaneous refreshes of the
     * same token deterministic: exactly one of them updates a row, and the loser sees
     * `count === 0` and gets a 401 instead of silently becoming a second live session.
     * Issuing before revoking would leak a live row (whose value nobody holds, but
     * which still counts as a session) whenever the revoke lost that race, and a
     * crash between the two statements would leave the account logged out with a live
     * token in the table. Revoking first risks only the logout, which is the failure
     * that a retry fixes.
     *
     * No `$transaction`: the create is conditional on a row that is now revoked, and
     * the intermediate state is one the client cannot observe.
     */
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: now },
    });

    if (count !== 1) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    await this.prisma.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });

    return {
      accessToken: await this.signAccessToken(stored.user),
      accessTokenExpiresAt: this.accessExpiry(now),
      refreshToken,
      refreshExpiresAt,
    };
  }

  /** Retires one refresh token, if it is still live (logout). */
  async revoke(presented: string, now: Date = new Date()): Promise<boolean> {
    /**
     * Shape first, and a `false` rather than a throw: a logout is a request to throw a
     * session away, and a client that presents a token this API never issued (or has
     * already retired) has got exactly what it asked for. A 401 here would strand it on
     * a "logout failed" screen with nothing to do - the value was not being presented
     * as access, it was being discarded.
     */
    if (!looksLikeRefreshToken(presented)) {
      return false;
    }

    const { count } = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(presented), revokedAt: null },
      data: { revokedAt: now },
    });

    return count === 1;
  }

  /**
   * Retires every live refresh token belonging to a user.
   *
   * `updateMany` with `revokedAt: null` rather than a blanket update: the column
   * records *when* a token was retired, and overwriting the original timestamp with a
   * later one would destroy the only evidence of when the session actually ended.
   * Returns the number retired, so the caller - which knows *why* it is revoking -
   * decides what to log.
   */
  async revokeAllForUser(userId: string, now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    return count;
  }

  /**
   * Signs the access token.
   *
   * Only `sub`: see the class comment for why nothing else is worth the staleness.
   * The lifetime comes from `JwtModule`'s `signOptions.expiresIn`, which is built
   * from the same `auth.accessTokenTtlMinutes` this class uses for
   * `accessTokenExpiresAt` - one config key, two expressions of it, and
   * `token.service.spec.ts` decodes a real token to prove they agree.
   */
  private async signAccessToken(user: SessionUser): Promise<string> {
    return this.jwt.signAsync({ sub: user.id });
  }

  /** When an access token signed at `now` stops being accepted. */
  private accessExpiry(now: Date): Date {
    return new Date(
      now.getTime() + this.config.getOrThrow<number>('auth.accessTokenTtlMinutes') * MINUTE_MS,
    );
  }

  /** When a refresh token issued at `now` stops being usable. */
  private refreshExpiry(now: Date): Date {
    return new Date(
      now.getTime() + this.config.getOrThrow<number>('auth.refreshTokenTtlDays') * DAY_MS,
    );
  }
}
