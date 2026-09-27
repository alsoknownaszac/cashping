import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';
import { type SessionUser } from '../token/token.service.js';

/** The request as the JWT strategy leaves it: `user` set once the guard has run. */
type AuthenticatedRequest = Request & { user?: SessionUser };

/**
 * Injects the signed-in user into a handler (Step 16).
 *
 * A parameter decorator rather than reading `request.user` inside the handler: the
 * dependency appears in the method signature, so "this route needs a user" is visible
 * where the route is declared, and the handler cannot accidentally be written as if
 * `user` were always there.
 *
 * The user it returns is the row `JwtStrategy` just read, not the token's claims -
 * see that class for why the read is deliberate.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (user === undefined) {
      /**
       * Only reachable by using this decorator on a route without `JwtAuthGuard` - a
       * wiring mistake, never a client error. It fails as loudly as a missing token
       * rather than handing the handler `undefined` to dereference somewhere deeper,
       * where the 500 would blame the wrong code.
       */
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    return user;
  },
);
