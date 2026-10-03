import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PASSWORD_SCRYPT_PARAMS, hashSecret, verifySecret } from '../credentials/secret-hash.js';

/**
 * The two ways a password change can be refused (Step 34b).
 *
 * `current_password_required` is its own reason rather than a 400 from the DTO because it
 * is a fact about the *account*: the same `{ password }` is a valid set on an account that
 * has no password and an incomplete change on one that has. `invalid_password` is a
 * current-password that did not match.
 *
 * A *wrong* password login is not here: that is `AuthService`'s answer, because it is the
 * same 401 as "no such user" and the two must not be distinguishable.
 */
export type PasswordChangeRefusal =
  | { ok: false; reason: 'current_password_required' }
  | { ok: false; reason: 'invalid_password' };

export type PasswordChangeOutcome = { ok: true; passwordSetAt: Date } | PasswordChangeRefusal;

/** The one column this service reads, and nothing else. */
interface PasswordState {
  passwordHash: string | null;
}

/**
 * The password: install it, change it, prove it (Step 34b).
 *
 * ## What it is, and what it is not
 *
 * A second way *in*, not a second factor. The transaction PIN (Step 34a) is what makes a
 * payment possible and is deliberately unrecoverable; the password is what gets a user back
 * into their account and is recoverable by SMS. The two are separate credentials with
 * separate rules, and the one thing they share is the hashing implementation
 * (`secret-hash.ts`) - with a stronger work factor here, because a password is guessed by
 * dictionary rather than swept.
 *
 * ## The rules this class exists to enforce
 *
 * 1. **The hash never leaves.** Nothing here returns `passwordHash`; `verify` answers a
 *    boolean and `change` a timestamp. The only reader of the column is `verifySecret`.
 * 2. **A change proves the current password.** Setting one where none exists is a set;
 *    replacing an existing one without the current password is refused, so an attacker
 *    holding a stolen access token still cannot lock the owner out of their own account.
 * 3. **A password login and a wrong one are the same answer.** `verify` returns a boolean
 *    for both "no password is set" and "it did not match" - the distinction is exactly what
 *    an enumeration attack reads off a response.
 *
 * ## What it deliberately does not do
 *
 * It decides no status codes (`AuthService`), it does not issue a session (that is
 * `TokenService`), and it does not rate-limit (the attempt counter is the OTP limiter's,
 * driven by `AuthService`, so that a guess is priced in one place).
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sets a password when there is none, or changes an existing one by proving it first.
   *
   * One method for both because they are one decision from the client's side - "here is the
   * password I want" - and which applies is a fact about the account: with no stored hash
   * there is nothing to prove, so `{ password }` alone installs one; with a stored hash,
   * `currentPassword` is required and checked.
   */
  async change(
    userId: string,
    currentPassword: string | undefined,
    password: string,
  ): Promise<PasswordChangeOutcome> {
    const state = await this.read(userId);

    if (state.passwordHash === null) {
      const passwordSetAt = await this.write(userId, password);

      await this.audit.log({ action: 'auth.password.set', userId, outcome: 'ok' });

      return { ok: true, passwordSetAt };
    }

    if (currentPassword === undefined) {
      return { ok: false, reason: 'current_password_required' };
    }

    if (!(await verifySecret(currentPassword, state.passwordHash))) {
      return { ok: false, reason: 'invalid_password' };
    }

    const passwordSetAt = await this.write(userId, password);

    await this.audit.log({ action: 'auth.password.changed', userId, outcome: 'ok' });

    return { ok: true, passwordSetAt };
  }

  /**
   * Answers whether `password` is this account's password.
   *
   * `false` for "no password is set" as well as for "it did not match", on purpose: the
   * caller builds one 401 for both, and a boolean that distinguished them is a boolean that
   * would be turned into two messages by the next person who reads it.
   */
  async verify(userId: string, password: string): Promise<boolean> {
    const state = await this.read(userId);

    if (state.passwordHash === null) {
      return false;
    }

    return verifySecret(password, state.passwordHash);
  }

  /**
   * Overwrites the account's password, in a change as well as a reset.
   *
   * A separate entry point for the reset path (`AuthService.confirmPasswordReset`), which
   * has already proved the account by SMS and must not be forced to prove a password it
   * does not know - the whole point of a reset. The proof for that path is the code, not
   * this credential.
   */
  async set(userId: string, password: string): Promise<Date> {
    const passwordSetAt = await this.write(userId, password);

    await this.audit.log({ action: 'auth.password.changed', userId, outcome: 'ok' });

    return passwordSetAt;
  }

  /**
   * The column this service reads, or a 401 if the row is gone.
   *
   * `JwtStrategy` has already read the user for a change, so reaching here with no row is a
   * deletion in the gap between the two reads; for a login the lookup is this method's own,
   * and the caller has already decided what an unknown account means.
   */
  private async read(userId: string): Promise<PasswordState> {
    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (state === null) {
      throw new UnauthorizedException('No account is associated with this session. Sign in again.');
    }

    return state;
  }

  /**
   * Hashes the password with the stronger work factor and writes it.
   *
   * The returned instant is *when the write happened*, not a column read back - there is no
   * `password_set_at` column, and none is added (Step 34b is explicit that the password
   * needs no migration), so the response reports the fact of the write rather than a stored
   * copy of it. The hash is the only thing that has to persist.
   */
  private async write(userId: string, password: string): Promise<Date> {
    const passwordHash = await hashSecret(password, PASSWORD_SCRYPT_PARAMS);
    const passwordSetAt = new Date();

    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    this.logger.log(`Password written for user ${userId}`);

    return passwordSetAt;
  }
}
