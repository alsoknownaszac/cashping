import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashSecret, verifySecret } from '../credentials/secret-hash.js';
import { generateOtpCode } from './otp-crypto.js';

/**
 * The result of checking a submitted code.
 *
 * A discriminated union rather than a thrown error, because every outcome here is
 * a *normal* one - a wrong code is a thing users do - and the caller decides what
 * each means over HTTP. The reasons are distinct on purpose: "expired" and "too
 * many attempts" need different words in front of a human than "not correct".
 */
export type OtpCheckOutcome =
  | { ok: true; otpId: string }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'too_many_attempts' | 'invalid_code';
      /** Wrong attempts left on this code, when the code is still usable. */
      attemptsRemaining?: number;
    };

export interface IssuedOtp {
  /** The plaintext code. Returned exactly once, to the caller that sends it. */
  code: string;
  expiresAt: Date;
}

/**
 * OTP lifecycle (Step 12): issue a hashed code, check one against storage.
 *
 * Storage rules this class exists to enforce:
 *   - the plaintext code is never persisted (only `hashSecret` output);
 *   - at most one live code per user, so a resend kills the previous one rather
 *     than leaving two valid codes behind;
 *   - a code is single-use, bounded by an expiry and by an attempt counter.
 *
 * What it deliberately does *not* do: rate limiting (that is Step 13, and it is
 * per phone number rather than per row), sending (Step 11) and any decision about
 * HTTP status codes (the caller's job).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issues a code for `userId`, replacing any code that is still live.
   *
   * The invalidate-then-create pair runs in one transaction so a failure cannot
   * leave the account with two live codes - or, worse, with none while the user
   * has just been told an SMS is on its way.
   *
   * `attempts` is left to the column default (0): the counter's starting point is
   * part of the table's definition, not something to restate here.
   */
  async issue(userId: string): Promise<IssuedOtp> {
    const codeLength = this.config.getOrThrow<number>('otp.codeLength');
    const ttlMinutes = this.config.getOrThrow<number>('otp.ttlMinutes');

    const now = new Date();
    const code = generateOtpCode(codeLength);
    const codeHash = await hashSecret(code);
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.otpVerification.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });

      await tx.otpVerification.create({
        data: { userId, codeHash, expiresAt },
      });
    });

    return { code, expiresAt };
  }

  /**
   * Checks a submitted code against the user's live code.
   *
   * On success the row is *not* consumed here: the caller consumes it in the same
   * transaction that marks the phone verified, so a crash between the two cannot
   * leave a spent code next to an unverified phone (see `AuthService.verifyOtp`).
   *
   * On failure the row is updated as needed - a wrong code increments the attempt
   * counter, and a dead code (expired, or out of attempts) is consumed so it can
   * never be retried.
   */
  async check(userId: string, code: string): Promise<OtpCheckOutcome> {
    const maxAttempts = this.config.getOrThrow<number>('otp.maxAttempts');
    const now = new Date();

    // The most recent live row, whatever its state: the point of reading it even
    // when it is expired or exhausted is to say *which* of those happened,
    // instead of a flat "wrong code" that sends the user to support.
    const row = await this.prisma.otpVerification.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (row === null) {
      return { ok: false, reason: 'not_found' };
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.consume(row.id, now);
      return { ok: false, reason: 'expired' };
    }

    // Checked *before* comparing, so a correct code submitted after the last
    // wrong attempt is still refused: the row is out of attempts, and honouring
    // it would make the limit "five wrong guesses, then guess once more".
    if (row.attempts >= maxAttempts) {
      await this.consume(row.id, now);
      return { ok: false, reason: 'too_many_attempts', attemptsRemaining: 0 };
    }

    if (await verifySecret(code, row.codeHash)) {
      return { ok: true, otpId: row.id };
    }

    const attempts = row.attempts + 1;

    if (attempts >= maxAttempts) {
      // The attempt that uses up the allowance consumes the row in the same
      // write, so there is no window in which a code with 0 attempts left is
      // still live.
      await this.prisma.otpVerification.update({
        where: { id: row.id },
        data: { attempts, consumedAt: now },
      });
      return { ok: false, reason: 'too_many_attempts', attemptsRemaining: 0 };
    }

    await this.prisma.otpVerification.update({
      where: { id: row.id },
      data: { attempts },
    });

    return { ok: false, reason: 'invalid_code', attemptsRemaining: maxAttempts - attempts };
  }

  /**
   * Marks a row spent. `updateMany` with `consumedAt: null` in the filter rather
   * than `update`: consuming an already-consumed row is a no-op instead of a
   * write, which keeps the call safe to reach twice.
   */
  private async consume(otpId: string, at: Date): Promise<void> {
    await this.prisma.otpVerification.updateMany({
      where: { id: otpId, consumedAt: null },
      data: { consumedAt: at },
    });
  }
}
