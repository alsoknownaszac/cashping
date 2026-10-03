import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { type Request } from 'express';
import { AuditService } from '../../audit/audit.service.js';
import { STEP_UP_TOKEN_HEADER } from '../../identity/pin/step-up-token.js';
import { StepUpTokenService } from '../../identity/pin/step-up-token.service.js';
import { type SessionUser } from '../../identity/token/token.service.js';

/** The request as the two guards leave it: `user` set, and the step-up header readable. */
type StepUpRequest = Request & {
  user?: SessionUser;
  headers: Record<string, string | string[] | undefined>;
};

/** Why a step-up was refused, as the audit row's short code. Never returned to the caller. */
type StepUpRefusal = 'missing' | 'invalid' | 'other_account' | 'no_authenticated_user';

/**
 * The guard in front of every route that moves money (Step 34a).
 *
 * ## What it establishes, and what it does not
 *
 * It establishes one fact for the request: **the caller proved their transaction PIN within
 * the last few minutes**. Nothing else. It does not know what a PIN is (the digits never
 * reach it), which payment is being created, or what the PIN protects - and that is the
 * point of putting it here rather than in `PaymentsService`: a payments service that had to
 * verify a credential would be a second place that could get credential handling wrong, and
 * the service's own docstring says it never learns what a PIN is.
 *
 * ## `denied`, not `401`
 *
 * A caller who has not presented a second factor is *authenticated* - the access token was
 * accepted, `JwtAuthGuard` ran first - and has simply not presented the other credential.
 * That is an authorisation refusal, so it is a **403**, and the audit row it writes carries
 * the outcome `denied` rather than `failed`: `failed` means "the operation did not happen",
 * `denied` means "it was not allowed to". Conflating them would make "someone tried to pay
 * without their PIN" indistinguishable from "a payment was refused by the bank".
 *
 * The audit row is written here rather than by the service the request never reached,
 * because this is the only place that knows *why* it was refused - and because a refusal
 * that leaves no trace is exactly the event a fraud review wants to see.
 *
 * ## The order, and the reason it matters
 *
 * `JwtAuthGuard` must run first (`@UseGuards(JwtAuthGuard, StepUpAuthGuard)`), because this
 * guard's last check is a comparison against the authenticated caller. Running without a
 * user is a wiring mistake rather than a client error, so it fails loudly as a 401 - the
 * same choice `CurrentUser` makes.
 */
@Injectable()
export class StepUpAuthGuard implements CanActivate {
  private readonly logger = new Logger(StepUpAuthGuard.name);

  constructor(
    private readonly tokens: StepUpTokenService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StepUpRequest>();
    const caller = request.user;

    if (caller === undefined) {
      // Reachable only by using this guard without `JwtAuthGuard` (or in the wrong order).
      // A 401 rather than a 403: there is no caller to have refused.
      await this.record(caller, 'no_authenticated_user');
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    const presented = request.headers[STEP_UP_TOKEN_HEADER];

    if (typeof presented !== 'string' || presented.trim() === '') {
      await this.record(caller, 'missing');
      throw this.refusal();
    }

    const owner = await this.tokens.verify(presented.trim());

    if (owner === null) {
      await this.record(caller, 'invalid');
      throw this.refusal();
    }

    /**
     * The token has to belong to *this* caller, and this comparison is the whole reason a
     * step-up token carries a subject at all. Without it, a token minted for any account -
     * one an attacker can create for themselves, prove a PIN on, and then use against
     * somebody else's session - would authorise a payment from any account holding any
     * valid access token.
     */
    if (owner !== caller.id) {
      await this.record(caller, 'other_account');
      throw this.refusal();
    }

    return true;
  }

  /**
   * The one answer every refusal gets.
   *
   * One message for a missing token, an expired one, a forged one and one belonging to
   * somebody else, for the reason `JwtAuthGuard` gives about its own 401: the caller's next
   * move is the same in all four cases (prove the PIN, then retry), and a message that says
   * *which* it was tells whoever is probing exactly what to fix.
   */
  private refusal(): ForbiddenException {
    return new ForbiddenException(
      `This request needs a fresh PIN confirmation. Send the token from POST /auth/pin/verify as ${STEP_UP_TOKEN_HEADER}.`,
    );
  }

  /**
   * Writes the refusal to the audit log.
   *
   * `auth.pin.failed` with outcome `denied` - the literal a wrong PIN also uses, and the
   * outcome that tells the two apart. A missing token is not a failed guess (no attempt was
   * made, and nothing in the row would be a PIN), which is exactly the distinction the
   * outcome exists for.
   */
  private async record(caller: SessionUser | undefined, reason: StepUpRefusal): Promise<void> {
    await this.audit.log({
      action: 'auth.pin.failed',
      userId: caller?.id,
      outcome: 'denied',
      metadata: { reason },
    });

    this.logger.warn(`Step-up refused (${reason})${caller === undefined ? '' : ` for ${caller.id}`}`);
  }
}
