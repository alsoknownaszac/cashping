import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { type SessionUser } from '../token/token.service.js';
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  type AccessTokenClaims,
} from './access-token.js';

/**
 * Lower-case UUID, the shape Prisma's `@db.Uuid` column accepts.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns a bearer token into `request.user` (Step 16).
 *
 * Two things happen here that are worth separating, because they are the answer to
 * two different questions.
 *
 * *Is this token ours?* Signature, algorithm, issuer, audience and expiry are checked
 * by `passport-jwt` before `validate` is called, using the same constants
 * `JwtModule` signed with. Nothing about the token's contents is trusted until then.
 *
 * *Is the user still allowed to act?* That is a database read, and it is the reason
 * this class exists rather than `ignoreExpiration`-only verification. An access token
 * cannot be withdrawn, so a suspension would otherwise stay toothless for up to 15
 * minutes: the read is what makes it immediate. The price is one indexed primary-key
 * lookup per authenticated request - measurable, and the honest cost of the design
 * rather than a hidden one. It also returns the freshly read row, so a handler never
 * works from claims that were true when the token was signed.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      /**
       * `Authorization: Bearer <token>` only.
       *
       * Not a cookie and not a query parameter. A cookie would need CSRF protection to
       * be safe (the browser attaches it to any cross-site request) and a query
       * parameter ends up in access logs, proxies and referrers. The frontend holds
       * the token and attaches it, which is the case the API is built for.
       */
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('auth.jwtSecret'),
      /** Exactly one algorithm: see `ACCESS_TOKEN_ALGORITHM`. */
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      /**
       * Stated rather than left to the default, because the default is the security
       * decision: `false` means `jsonwebtoken` rejects a token whose `exp` has passed,
       * and this is the only thing enforcing the 15-minute lifetime.
       */
      ignoreExpiration: false,
    });
  }

  /**
   * Runs only for a token that has already been verified, and returns what
   * `request.user` will hold.
   */
  async validate(payload: AccessTokenClaims): Promise<SessionUser> {
    /**
     * A `sub` that is not a UUID cannot come from this API - `signAccessToken` writes
     * the user id and nothing else - but it *can* be sent by hand by anyone holding a
     * valid signature (a rotated secret that has not fully drained from a client, a
     * token minted by a test). Checking the shape here keeps a garbage id from
     * reaching a `uuid` column, where Prisma would raise a validation error and the
     * caller would get a 500 for what is really a bad credential.
     */
    if (typeof payload.sub !== 'string' || !UUID_PATTERN.test(payload.sub)) {
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, phoneNumber: true, status: true, handle: true },
    });

    if (user === null) {
      // The token is validly signed but the row is gone (deleted account, or a
      // database restored from before it existed). 401, not 404: the caller's
      // credential is what is wrong, and the response should not confirm whether an
      // id ever existed.
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    return user;
  }
}
