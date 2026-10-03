import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashSecret, verifySecret } from '../credentials/secret-hash.js';

/**
 * The three ways a PIN can be refused, shared by both endpoints.
 *
 * They live in their own type because only the *success* differs between proving a PIN (a
 * step-up token) and changing one (a timestamp): a refusal is a refusal, and `recordWrongPin`
 * returns exactly this, so it can answer `change` and `verify` alike.
 *
 * `not_set` is a refusal rather than an error: an account with no PIN (a Google-SSO account
 * before it sets one, per Step 34d) has nothing to guess, and the caller's next move is to set
 * one rather than to try again.
 */
export type PinRefusal =
  | { ok: false; reason: 'not_set' }
  | { ok: false; reason: 'invalid_pin'; attemptsRemaining: number }
  | { ok: false; reason: 'locked'; lockedUntil: Date };

/**
 * What one submission of a PIN proved (Step 34a).
 *
 * A discriminated union rather than a thrown error, for the reason `OtpCheckOutcome` is
 * one: apart from `ok`, every outcome here is a *normal* answer - a customer mistypes a
 * PIN - and the caller decides what each means over HTTP. The reasons are distinct
 * because the sentences in front of a human are different: "not correct, 3 attempts
 * left", "locked until 10:15", "no PIN is set yet".
 *
 * The HTTP mapping is deliberately *not* here, and the reason is visible in the two
 * callers: a wrong PIN is a 401 on the step-up endpoint and a 409 on the change endpoint.
 * One fact, two answers, so the fact belongs in this class and the answers belong to
 * `AuthService`.
 */
export type PinAttemptOutcome = { ok: true } | PinRefusal;

/**
 * What one call to the change endpoint did.
 *
 * `current_pin_required` is its own reason rather than a 400 from the DTO because it is a
 * fact about the *account*, not about the body: the same `{ pin }` is a valid set on an
 * account that has no PIN and an incomplete change on one that has.
 */
export type PinChangeRefusal = { ok: false; reason: 'current_pin_required' } | PinRefusal;

export type PinChangeOutcome = { ok: true; pinSetAt: Date } | PinChangeRefusal;

/** Which endpoint a wrong PIN arrived on. Never a PIN, a hash or a phone number. */
type PinContext = 'verify' | 'change';

/** Milliseconds in a minute, for turning the configured lockout into an instant. */
const MINUTE_MS = 60_000;

/** The columns this service needs, and nothing else: the rest of the row is not its business. */
interface PinState {
  transactionPinHash: string | null;
  transactionPinAttempts: number;
  transactionPinLockedUntil: Date | null;
}

/**
 * The transaction PIN: install it, change it, prove it (Step 34a).
 *
 * ## What it is, and why it exists
 *
 * A second factor in front of money. Registration collects four digits up front - the
 * credential every later payment depends on - and `POST /v1/payments` refuses to run
 * without proof that those digits were given in the last few minutes. It is deliberately
 * *not* another password: it is short, it is never a way to sign in, and it cannot be
 * reset by email or SMS, so a stolen session is still not enough to move money.
 *
 * ## The three rules this class exists to enforce
 *
 * 1. **The hash never leaves.** Nothing here returns `transactionPinHash`, and the only
 *    thing that reads it is `verifySecret`. A caller that wanted to compare a PIN would
 *    have to grow its own copy of this service.
 * 2. **A wrong PIN costs something.** Five wrong submissions lock the PIN for fifteen
 *    minutes (both from `configuration.ts`), and the counter is incremented *atomically*:
 *    reading the count and writing back `count + 1` would let two hundred parallel
 *    requests share one attempt, which for a four-digit PIN is the difference between a
 *    lockout and a sweep of ten thousand values.
 * 3. **The change endpoint is not a bypass.** Proving the current PIN to change it is the
 *    same credential as proving it to pay, so it goes through the same counter and the
 *    same lockout. A change path with arithmetic of its own would be a second, quieter
 *    guess counter - the one an attacker holding a stolen access token would use.
 *
 * ## What it deliberately does not do
 *
 * It does not issue the step-up token (`StepUpTokenService` does, because that is a
 * token-shaped question), it decides no status codes (`AuthService`), and it touches no
 * phone number, no SMS and no session.
 */
@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sets a PIN when there is none, or changes an existing one by proving it first.
   *
   * One method for both because they are one decision from the client's side, and which
   * one applies is a fact about the account: with no stored PIN there is nothing to
   * prove, so `{ pin }` alone installs one; with a stored PIN, `currentPin` is required
   * and is checked through the same attempt counter a payment step-up uses.
   *
   * The order the answers are decided in is deliberate. A locked account is told it is
   * locked first - before the missing-`currentPin` case - and the lock is checked *before*
   * the comparison, so a correct `currentPin` presented while locked is still refused.
   * Otherwise "locked" would mean "five wrong guesses, then try the real one".
   */
  async change(
    userId: string,
    currentPin: string | undefined,
    pin: string,
  ): Promise<PinChangeOutcome> {
    const state = await this.read(userId);

    if (state.transactionPinHash === null) {
      const pinSetAt = await this.writePin(userId, pin);

      await this.audit.log({
        action: 'auth.pin.set',
        userId,
        outcome: 'ok',
        metadata: { source: 'set' },
      });

      return { ok: true, pinSetAt };
    }

    const locked = this.lockedUntil(state);

    if (locked !== null) {
      return { ok: false, reason: 'locked', lockedUntil: locked };
    }

    if (currentPin === undefined) {
      return { ok: false, reason: 'current_pin_required' };
    }

    if (!(await verifySecret(currentPin, state.transactionPinHash))) {
      return this.recordWrongPin(userId, 'change');
    }

    const pinSetAt = await this.writePin(userId, pin);

    await this.audit.log({ action: 'auth.pin.changed', userId, outcome: 'ok' });

    return { ok: true, pinSetAt };
  }

  /**
   * Proves the PIN: the step-up call a payment needs.
   *
   * On success the attempt counter is cleared *and* any expired lock is wiped, so the
   * account is left in the state a correct PIN produces rather than in one that merely
   * tolerates it.
   *
   * `not_set` is not a wrong PIN and is deliberately not counted as one: an account with
   * no PIN yet (a Google-SSO account before it sets one, per Step 34d) has nothing to
   * guess, and counting it would let anyone lock an account out of an endpoint it cannot
   * use anyway.
   */
  async verify(userId: string, pin: string): Promise<PinAttemptOutcome> {
    const state = await this.read(userId);

    if (state.transactionPinHash === null) {
      return { ok: false, reason: 'not_set' };
    }

    const locked = this.lockedUntil(state);

    if (locked !== null) {
      return { ok: false, reason: 'locked', lockedUntil: locked };
    }

    if (!(await verifySecret(pin, state.transactionPinHash))) {
      return this.recordWrongPin(userId, 'verify');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { transactionPinAttempts: 0, transactionPinLockedUntil: null },
    });

    await this.audit.log({ action: 'auth.pin.verified', userId, outcome: 'ok' });

    return { ok: true };
  }

  /**
   * The columns this service reads, or a 401 if the row is gone.
   *
   * `JwtStrategy` has already read the user for this request, so the only way to reach
   * here with no row is a deletion in the gap between the two reads. A 401 is the honest
   * answer rather than a 404 or a 500: the session's subject no longer exists, which is
   * exactly what a credential that cannot be accepted looks like.
   */
  private async read(userId: string): Promise<PinState> {
    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        transactionPinHash: true,
        transactionPinAttempts: true,
        transactionPinLockedUntil: true,
      },
    });

    if (state === null) {
      throw new UnauthorizedException('No account is associated with this session. Sign in again.');
    }

    return state;
  }

  /** The instant a live lock lifts, or `null` when the PIN is not locked. */
  private lockedUntil(state: PinState): Date | null {
    if (state.transactionPinLockedUntil === null) {
      return null;
    }

    return state.transactionPinLockedUntil.getTime() > Date.now()
      ? state.transactionPinLockedUntil
      : null;
  }

  /**
   * Writes a new hash, and the state that has to travel with it.
   *
   * `attempts` and `lockedUntil` are reset in the same write rather than left alone: a new
   * PIN is a new credential, so the old one's wrong guesses - and any lock earned against
   * it - are not facts about this one.
   */
  private async writePin(userId: string, pin: string): Promise<Date> {
    const transactionPinHash = await hashSecret(pin);
    const pinSetAt = new Date();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        transactionPinHash,
        transactionPinSetAt: pinSetAt,
        transactionPinAttempts: 0,
        transactionPinLockedUntil: null,
      },
    });

    return pinSetAt;
  }

  /**
   * Counts one wrong PIN, locks the PIN if that was the allowance, and answers which of
   * the two happened.
   *
   * The increment is done by the database (`{ increment: 1 }`) rather than in this
   * process, which is the whole point of the method: a read-then-write would let
   * concurrent guesses all see the same starting count, and the attempt limit would then
   * depend on how many requests a caller can send at once instead of on how many were
   * sent.
   *
   * The attempt that uses up the allowance locks the PIN *and* resets the counter, in one
   * follow-up write: the counter measures the current window, and the lock is that
   * window's consequence. Leaving it at the maximum would mean a lock that expires into an
   * account that locks itself again on the next mistake.
   */
  private async recordWrongPin(userId: string, context: PinContext): Promise<PinRefusal> {
    const maxAttempts = this.config.getOrThrow<number>('pin.maxAttempts');
    const lockoutMinutes = this.config.getOrThrow<number>('pin.lockoutMinutes');

    const after = await this.prisma.user.update({
      where: { id: userId },
      data: { transactionPinAttempts: { increment: 1 } },
      select: { transactionPinAttempts: true },
    });

    if (after.transactionPinAttempts >= maxAttempts) {
      const lockedUntil = new Date(Date.now() + lockoutMinutes * MINUTE_MS);

      await this.prisma.user.update({
        where: { id: userId },
        data: { transactionPinAttempts: 0, transactionPinLockedUntil: lockedUntil },
      });

      /**
       * No PIN, no hash, no phone number: which endpoint it arrived on, what is left of the
       * allowance, and how long the lock is. `AuditEntry.metadata` is where that rule is
       * stated rather than a preference of this call site - and it is what makes the row
       * useful, because "someone is guessing a PIN" and "someone's connection retried"
       * have to be told apart by the reader.
       */
      await this.audit.log({
        action: 'auth.pin.failed',
        userId,
        outcome: 'failed',
        metadata: { context, attemptsRemaining: 0, lockedForMinutes: lockoutMinutes },
      });

      this.logger.warn(
        `Transaction PIN locked for user ${userId} after ${maxAttempts} wrong attempts (${context}).`,
      );

      return { ok: false, reason: 'locked', lockedUntil };
    }

    const attemptsRemaining = maxAttempts - after.transactionPinAttempts;

    await this.audit.log({
      action: 'auth.pin.failed',
      userId,
      outcome: 'failed',
      metadata: { context, attemptsRemaining },
    });

    return { ok: false, reason: 'invalid_pin', attemptsRemaining };
  }
}
