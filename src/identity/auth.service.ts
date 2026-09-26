import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CountryCode } from 'libphonenumber-js';
import {
  InvalidPhoneNumberError,
  maskPhoneNumber,
  normalizePhoneNumber,
} from '../common/phone/phone-number.js';
import { UserStatus } from '../generated/prisma/enums.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type RegisterDto } from './dto/register.dto.js';
import { type RegisterResponseDto } from './dto/register-response.dto.js';
import { type VerifyOtpDto } from './dto/verify-otp.dto.js';
import { type VerifyOtpResponseDto } from './dto/verify-otp-response.dto.js';
import {
  OtpRateLimitExceededError,
  OtpRateLimitUnavailableError,
  OtpRateLimiterService,
} from './otp/otp-rate-limiter.service.js';
import { OtpService, type OtpCheckOutcome } from './otp/otp.service.js';

/**
 * Registration and OTP verification (Steps 10 and 14).
 *
 * The order of the steps inside `register` is the interesting part, and each
 * choice is commented where it happens. Two rules shape all of it: a phone number
 * is normalized *before* it reaches a query or a write (there is a unique index on
 * `phone_number`, so an unnormalized lookup would miss an existing user and try to
 * create a second row for them), and no code is ever returned to the caller.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly otp: OtpService,
    private readonly otpRateLimiter: OtpRateLimiterService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Starts (or restarts) registration for a phone number and sends a code.
   *
   * Outcomes, in the order they are decided:
   *   - the number is already `ACTIVE`  -> 409, sign in instead;
   *   - the number is `SUSPENDED`       -> 403, and no code is sent;
   *   - over the request limit          -> 429, before any write;
   *   - otherwise                       -> 201 with a `PENDING_VERIFICATION` user.
   *
   * A number already in `PENDING_VERIFICATION` is *not* an error: it is the
   * resend path (the first SMS was never typed in, or never arrived). The row is
   * reused so the user id survives, and the previous code is invalidated by
   * `OtpService.issue`.
   */
  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    /**
     * Existence is checked *before* the rate limit on purpose. A request for a
     * number that is already active sends no SMS, so it must not consume that
     * number's allowance - otherwise anyone could lock a real user out of ever
     * receiving a code again by asking about their number four times.
     */
    const existing = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (existing?.status === UserStatus.ACTIVE) {
      throw new ConflictException(
        'That number is already registered. Verify with a code instead, or use a different number.',
      );
    }

    if (existing?.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    // Counted before the user row is created, so a blocked request leaves nothing
    // behind: an over-limit caller gets no row, no code and no SMS.
    await this.assertWithinRequestLimit(phoneNumber);

    const user =
      existing ??
      (await this.prisma.user.create({
        // `status` is left to the column default (`PENDING_VERIFICATION`) rather
        // than restated here: a create path that spells it out is a create path
        // that can later spell it out wrongly.
        data: { phoneNumber },
      }));

    const { code, expiresAt } = await this.otp.issue(user.id);
    await this.sendOtp(phoneNumber, code);

    return {
      userId: user.id,
      phoneNumber,
      status: user.status,
      // ISO-8601 on the wire, matching `HealthResponseDto.timestamp`: the
      // response body holds a string, so the DTO does too, and the conversion
      // happens at the boundary that computed the value.
      expiresAt: expiresAt.toISOString(),
      codeLength: this.config.getOrThrow<number>('otp.codeLength'),
    };
  }

  /**
   * Verifies a code and activates the account (Step 14).
   *
   * Outcomes:
   *   - no user for the number           -> 404;
   *   - already `ACTIVE`                 -> 409;
   *   - no live code / wrong / expired   -> 400;
   *   - out of attempts                  -> 429 (the code is dead, ask for a new one);
   *   - correct                          -> 200, `ACTIVE` with `phoneVerifiedAt`.
   */
  async verifyOtp(dto: VerifyOtpDto): Promise<VerifyOtpResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user === null) {
      throw new NotFoundException(
        'No registration found for that number. Register first to get a code.',
      );
    }

    if (user.status === UserStatus.ACTIVE) {
      throw new ConflictException('That number is already verified.');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    const outcome = await this.otp.check(user.id, dto.code);

    if (!outcome.ok) {
      throw this.toHttpException(outcome);
    }

    const verifiedAt = new Date();

    /**
     * Both writes are one fact - this code proved this number - so they share a
     * transaction. Consuming the code and activating the user separately would
     * leave a window in which a crash produced an unverified user whose code was
     * already spent, or (worse) an activated user whose code could still be
     * presented again.
     */
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.otpVerification.updateMany({
        where: { id: outcome.otpId, consumedAt: null },
        data: { consumedAt: verifiedAt },
      });

      if (consumed.count === 0) {
        // The row was live when it was checked and is not any more: the same
        // person double-tapping "verify", most likely. Throwing rolls the whole
        // transaction back, so the user is not activated by a code that is no
        // longer live - the second request gets a clear refusal instead.
        throw new ConflictException('That code has already been used. Request a new one.');
      }

      await tx.user.update({
        where: { id: user.id },
        data: { status: UserStatus.ACTIVE, phoneVerifiedAt: verifiedAt },
      });
    });

    this.logger.log(`Phone verified for ${maskPhoneNumber(phoneNumber)} (user ${user.id})`);

    return {
      userId: user.id,
      phoneNumber,
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: verifiedAt.toISOString(),
    };
  }

  /**
   * Normalizes a submitted number, or answers 400.
   *
   * The raw input is echoed back in the message: it is the caller's own value, and
   * "which of the numbers I sent was bad" is the one thing they cannot work out
   * from a generic complaint.
   */
  private normalize(input: string): string {
    // The region was validated against libphonenumber's own metadata at boot
    // (`validation.schema.ts`), and uppercased by `configuration()`, so the cast
    // states a fact rather than hoping for one.
    const defaultRegion = this.config.getOrThrow<string>('phone.defaultRegion') as CountryCode;

    try {
      return normalizePhoneNumber(input, defaultRegion);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new BadRequestException(
          `"${input}" is not a valid phone number. Use a full number, e.g. +233241234567.`,
        );
      }

      throw error;
    }
  }

  /** Counts a send against the number's allowance, or refuses. */
  private async assertWithinRequestLimit(phoneNumber: string): Promise<void> {
    try {
      await this.otpRateLimiter.consume(phoneNumber);
    } catch (error) {
      if (error instanceof OtpRateLimitExceededError) {
        const minutes = Math.ceil(error.retryAfterSeconds / 60);

        throw new HttpException(
          `Too many verification codes requested for this number. Try again in ${minutes} minute${
            minutes === 1 ? '' : 's'
          }.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof OtpRateLimitUnavailableError) {
        // 5xx by design, and the global filter answers every 5xx with a generic
        // message: the real reason (Redis) belongs in the log, not in front of a
        // user. What the client can act on is the status code - nothing was sent,
        // try again shortly.
        throw new ServiceUnavailableException(
          'Verification is temporarily unavailable. Please try again in a moment.',
        );
      }

      throw error;
    }
  }

  /**
   * Sends the code, translating any provider failure into "nothing was sent".
   *
   * The user row and the code already exist at this point, and they are left in
   * place: the row is harmless (it is `PENDING_VERIFICATION` with no way to be
   * activated except a code the user never received), and deleting it would race
   * with a concurrent registration for the same number. The client's retry is to
   * call register again, which is another send and is rate limited like any other.
   */
  private async sendOtp(phoneNumber: string, code: string): Promise<void> {
    try {
      await this.notifications.sendOtp(phoneNumber, code);
    } catch (error) {
      this.logger.error(
        `Could not send the OTP SMS for ${maskPhoneNumber(phoneNumber)}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new ServiceUnavailableException(
        'We could not send the verification code right now. Please try again.',
      );
    }
  }

  /**
   * Maps an OTP check failure onto the response the caller gets.
   *
   * `too_many_attempts` is a 429 rather than a 400: the request was understood and
   * the caller has to do something different next time (wait, then ask for a new
   * code), which is what 429 says. The attempts left are in the message for the
   * wrong-code case, because "3 attempts remaining" is the difference between a
   * user retyping a digit and a user giving up.
   */
  private toHttpException(outcome: Extract<OtpCheckOutcome, { ok: false }>): HttpException {
    switch (outcome.reason) {
      case 'not_found':
        return new BadRequestException(
          'No verification code is outstanding for this number. Request a new one.',
        );

      case 'expired':
        return new BadRequestException('That code has expired. Request a new one.');

      case 'too_many_attempts':
        return new HttpException(
          'Too many incorrect attempts. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );

      case 'invalid_code':
        return new BadRequestException(
          `That code is not correct. ${outcome.attemptsRemaining ?? 0} attempts remaining.`,
        );
    }
  }
}
