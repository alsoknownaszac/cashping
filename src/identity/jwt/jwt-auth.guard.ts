import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { type SessionUser } from '../token/token.service.js';

/**
 * The guard on every route that needs a signed-in user (Step 16).
 *
 * A named subclass of `AuthGuard('jwt')` rather than the inline
 * `@UseGuards(AuthGuard('jwt'))` the Nest docs show, for two reasons: the route then
 * reads `@UseGuards(JwtAuthGuard)`, which is a name in the codebase that can be
 * grepped and changed in one place, and the one behaviour worth overriding - the 401
 * - has somewhere to live.
 *
 * Registered per route rather than globally, deliberately: a global guard would make
 * every endpoint authenticated by default and force `@Public()` exceptions onto
 * `health`, `/`, registration and login. Fail-closed is the better default in
 * general, but here it would mean an unauthenticated `/health` only stays
 * unauthenticated as long as nobody forgets the marker, and a missing marker on a
 * liveness probe is an outage. When the admin guard arrives it composes with this one,
 * so the per-route style is also what keeps that possible.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /**
   * One message for every way a token can be rejected.
   *
   * `passport-jwt` knows the difference between expired, malformed and
   * wrong-signature, and passes it in as `info`. None of it is repeated to the caller:
   * the client's response to all three is identical (refresh, or sign in again), so
   * the only thing a specific message would add is a free oracle for someone probing
   * the signature.
   */
  handleRequest<TUser = SessionUser>(err: unknown, user: TUser | false): TUser {
    /**
     * A failure thrown by `JwtStrategy.validate` - a suspended account, a user that
     * no longer exists - arrives here as `err`, and it has to keep its status.
     * Rewriting the strategy's 403 into a 401 would tell a suspended user to sign in
     * again, which is the one thing that cannot help them.
     */
    if (err) {
      throw err;
    }

    if (!user) {
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    return user;
  }
}
