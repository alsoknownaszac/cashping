import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OtpService, type OtpCheckOutcome } from '../otp/otp.service.js';

/**
 * The one way attaching an address can be refused (Step 34c): another account holds it.
 *
 * `users.email` is unique, so this is the unique index speaking, and it covers an address
 * that another account has merely *claimed* as well as one it has verified - the two are
 * one 409, because a client can act on neither differently.
 */
export type EmailSetRefusal = { ok: false; reason: 'address_taken' };

/** What attaching an address produced: the code to deliver, or the conflict. */
export type EmailSetOutcome =
  | { ok: true; email: string; code: string; expiresAt: Date }
  | EmailSetRefusal;

/**
 * The ways confirming an address can be refused.
 *
 * `no_address` is a fact about the account (nothing to confirm yet); `already_verified` is
 * a fact about it too (this one is done); everything else is the OTP check's own outcome,
 * carried through unchanged so `AuthService` maps it with the same table a phone code uses.
 */
export type EmailVerifyRefusal =
  | { ok: false; reason: 'no_address' | 'already_verified' }
  | { ok: false; reason: 'code'; failure: Extract<OtpCheckOutcome, { ok: false }> };

export type EmailVerifyOutcome =
  | { ok: true; email: string; emailVerifiedAt: Date }
  | EmailVerifyRefusal;

/**
 * The email address: attach it, confirm it (Step 34c).
 *
 * ## What it holds, and where
 *
 * The address lives in two columns on `users`: `email` (the claimed address, lower-cased)
 * and `email_verified_at` (when a code proved the account controls it). "Attached but not
 * confirmed" is therefore `email IS NOT NULL AND email_verified_at IS NULL`, which is the
 * state a receipt must **not** be sent to - an address is only good for delivery once the
 * person who receives it has proved they can read it. That split is the whole reason there
 * are two columns rather than a boolean.
 *
 * ## The verification code is an OTP
 *
 * Issuing and checking the code reuses `OtpService`, exactly as the password reset does:
 * a verification code is an OTP with a different *purpose*, not a second code system, and a
 * second one would be a second set of expiry, attempt and single-use rules to keep in step.
 * What is different is only where the proof lands - `email_verified_at` here, a new password
 * there.
 *
 * ## What it deliberately does not do
 *
 * It does not send anything: `AuthService` hands the code to `NotificationsService`, so the
 * wording and the transport stay behind the notification seam. It decides no additional
 * status codes beyond the conflict it raises for a lost race.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Attaches (or replaces) the account's address and issues a code to confirm it.
   *
   * The address is written *unverified* - `email_verified_at` is cleared in the same write -
   * so replacing an address with a typo in it cannot leave a receipt going somewhere the
   * account's owner never proved. Confirmation is the next call, with the code this returns.
   *
   * The uniqueness check reads before it writes for the ordinary case (a clean 409 with a
   * message), and the column's unique index is the guarantee: two requests can pass this
   * check in the same instant, and the second one to commit is refused by the index itself -
   * the `P2002` caught below becomes the same `address_taken` the read returns, so the caller
   * maps both paths with one table.
   */
  async set(userId: string, email: string): Promise<EmailSetOutcome> {
    const holder = await this.prisma.user.findFirst({
      where: { email, id: { not: userId } },
      select: { id: true },
    });

    if (holder !== null) {
      return { ok: false, reason: 'address_taken' };
    }

    /**
     * The write is what actually enforces uniqueness; the read above is only the ordinary path
     * to the message. Two requests for the same address can pass that read together, and the
     * second one to commit then trips the unique index and raises `P2002` - a lost race, not a
     * failure, so it has to read as the same conflict the read returns rather than reach the
     * global filter as a 500. Every other error keeps travelling, because a genuine database
     * failure belongs in a 500 and in Sentry.
     */
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { email, emailVerifiedAt: null },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { ok: false, reason: 'address_taken' };
      }

      throw error;
    }

    /**
     * Step 33-ish vocabulary: `auth.email.set`, written before the code is sent and for the
     * same reason `auth.pin.set` follows the row at registration - the fact ("this account
     * now holds this address") is already true, whether or not an email is delivered. The
     * address itself is deliberately absent: `metadata` carries the `userId` and nothing
     * more, because an address is a personal identifier and this table's rule is that
     * identifiers other than the account id do not appear in the clear.
     */
    await this.audit.log({
      action: 'auth.email.set',
      userId,
      outcome: 'ok',
      metadata: { userId },
    });

    const { code, expiresAt } = await this.otp.issue(userId);

    this.logger.log(`Email verification code issued for user ${userId}`);

    return { ok: true, email, code, expiresAt };
  }

  /**
   * Confirms the account's address with a code, or says why it could not.
   *
   * The code is spent and `email_verified_at` is stamped in one transaction, which is the
   * same pairing `AuthService.verifyOtp` uses for a phone: a crash between the two would
   * otherwise leave a spent code next to an unverified address, or an address marked
   * verified by a code that can still be presented again.
   */
  async verify(userId: string, code: string): Promise<EmailVerifyOutcome> {
    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });

    if (state === null) {
      throw new UnauthorizedException('No account is associated with this session. Sign in again.');
    }

    if (state.email === null) {
      return { ok: false, reason: 'no_address' };
    }

    if (state.emailVerifiedAt !== null) {
      return { ok: false, reason: 'already_verified' };
    }

    const outcome = await this.otp.check(userId, code);

    if (!outcome.ok) {
      return { ok: false, reason: 'code', failure: outcome };
    }

    const emailVerifiedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.otpVerification.updateMany({
        where: { id: outcome.otpId, consumedAt: null },
        data: { consumedAt: emailVerifiedAt },
      });

      if (count === 0) {
        throw new ConflictException('That code has already been used. Request a new one.');
      }

      await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt } });
    });

    await this.audit.log({
      action: 'auth.email.verified',
      userId,
      outcome: 'ok',
      metadata: { userId },
    });

    this.logger.log(`Email verified for user ${userId}`);

    return { ok: true, email: state.email, emailVerifiedAt };
  }
}
