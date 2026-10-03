import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  STEP_UP_TOKEN_ALGORITHM,
  STEP_UP_TOKEN_AUDIENCE,
  STEP_UP_TOKEN_ISSUER,
  type StepUpTokenClaims,
} from './step-up-token.js';

/** A freshly minted step-up token, with its expiry resolved to a Date. */
export interface IssuedStepUpToken {
  token: string;
  expiresAt: Date;
}

/** Milliseconds in a minute, for turning the configured lifetime into an instant. */
const MINUTE_MS = 60_000;

/**
 * Mints and verifies the step-up token (Step 34a).
 *
 * It is a separate service from `TokenService` on purpose. `TokenService` owns *sessions* -
 * a pair of tokens, a refresh row, rotation, revocation - and none of that applies here: a
 * step-up token is signed, never stored, cannot be refreshed, and expires in minutes. The
 * two do share the signing secret, which is why they live in the same bounded context and
 * why the audience (`step-up-token.ts`) is what keeps them apart.
 *
 * ## Why `verify` returns `null` rather than throwing
 *
 * Every way a step-up token can fail - expired, signed with another secret, for another
 * audience, not a token at all - is the same answer to the caller: the payment is refused.
 * Turning them into distinct exceptions would produce distinct messages, and a message that
 * says *why* a forged token was refused is free information for whoever is forging them.
 * `StepUpAuthGuard` is where the one answer is turned into one response.
 *
 * ## Why the audience is named at the call site
 *
 * `signOptions` are declared once in `StepUpModule`, so a minted token cannot be missing its
 * audience. Verification names all three (`algorithms`, `issuer`, `audience`) explicitly
 * instead of trusting a library default: a default that changes, or that is never applied
 * to `verify`, fails silently in the direction of *accepting* a token, which is the one
 * failure mode worth being verbose about.
 */
@Injectable()
export class StepUpTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Mints a step-up token for a user whose PIN was just proved.
   *
   * `now` is a parameter so the expiry is computed from the same instant the token was
   * signed at, and so a test can assert the lifetime without waiting for it.
   */
  async issue(userId: string, now: Date = new Date()): Promise<IssuedStepUpToken> {
    const ttlMinutes = this.config.getOrThrow<number>('pin.stepUpTokenTtlMinutes');

    return {
      token: await this.jwt.signAsync({ sub: userId }),
      expiresAt: new Date(now.getTime() + ttlMinutes * MINUTE_MS),
    };
  }

  /**
   * The user id a step-up token was minted for, or `null` if it is not one of ours.
   *
   * A verified token is *not* on its own an authorisation: the caller still has to be the
   * account the token names, which is `StepUpAuthGuard`'s comparison. This method's whole
   * job is "this token is ours and has not expired", and it deliberately stops there.
   */
  async verify(token: string): Promise<string | null> {
    try {
      const payload = await this.jwt.verifyAsync<StepUpTokenClaims>(token, {
        algorithms: [STEP_UP_TOKEN_ALGORITHM],
        issuer: STEP_UP_TOKEN_ISSUER,
        audience: STEP_UP_TOKEN_AUDIENCE,
      });

      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      // Deliberately swallowed: see the class docstring. The exception a forged token
      // raises is not an error condition, it is the answer "no".
      return null;
    }
  }
}
