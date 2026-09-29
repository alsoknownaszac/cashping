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
import { Prisma } from '../generated/prisma/client.js';
import { UserStatus } from '../generated/prisma/enums.js';
import { type UserModel } from '../generated/prisma/models.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  // A value import, not `import type`: Nest resolves this constructor parameter from
  // emitted metadata, and a type-only import erases the class that the metadata names.
  AccountProvisioningService,
  type ProvisioningOutcome,
} from '../wallet/provisioning/account-provisioning.service.js';
import { type LoginCodeResponseDto } from './dto/login-code-response.dto.js';
import { type LoginDto, type LoginResponseDto } from './dto/login.dto.js';
import { type SubmittedPhoneNumberDto } from './dto/phone-number.dto.js';
import { type RefreshTokenDto } from './dto/refresh-token.dto.js';
import { type RegisterDto } from './dto/register.dto.js';
import { type RegisterResponseDto } from './dto/register-response.dto.js';
import { type SessionResponseDto } from './dto/session-response.dto.js';
import { type TokenPairResponseDto } from './dto/token-pair-response.dto.js';
import { type VerifyOtpDto } from './dto/verify-otp.dto.js';
import { type VerifyOtpResponseDto } from './dto/verify-otp-response.dto.js';
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  InvalidHandleError,
  assertHandleAllowed,
} from './handle/handle.js';
import {
  OtpRateLimitExceededError,
  OtpRateLimitUnavailableError,
  OtpRateLimiterService,
} from './otp/otp-rate-limiter.service.js';
import { OtpService, type OtpCheckOutcome } from './otp/otp.service.js';
import { TokenService, type IssuedTokens, type SessionUser } from './token/token.service.js';

/**
 * The columns of a user row that registration actually reads back.
 *
 * A `Pick` rather than the whole model: `claimAccount` needs an id, a status and a
 * handle, and naming them is what stops the helper from depending on every column
 * the `users` table ever gains.
 */
type RegisteredUser = Pick<UserModel, 'id' | 'status' | 'handle'>;

/**
 * The wallet half of a verification log line (Step 19).
 *
 * `provisioned` and `already-provisioned` are the same good news for the operator - the
 * user has an account - and `incomplete` names how far the attempt got, which
 * `AccountProvisioningService` has already logged in detail (public key, transaction
 * hashes, stage). What this adds is one line per verification instead of a line the
 * operator has to join against another by user id.
 */
function describeWallet(outcome: ProvisioningOutcome): string {
  return outcome.status === 'incomplete'
    ? `wallet incomplete${outcome.stage === undefined ? '' : ` at stage ${outcome.stage}`}`
    : `wallet ${outcome.status}`;
}

/**
 * Registration, OTP verification and sessions (Steps 10, 14 and 16).
 *
 * The order of the steps inside `register` is the interesting part, and each
 * choice is commented where it happens. Two rules shape all of it: a phone number
 * is normalized *before* it reaches a query or a write (there is a unique index on
 * `phone_number`, so an unnormalized lookup would miss an existing user and try to
 * create a second row for them), and no code is ever returned to the caller.
 *
 * Step 16 added two flows that spend a code - verification and sign-in - and they share
 * `checkCode` and `consumeCode` for that reason. What they do *after* the code is
 * checked is where they differ, and the difference is the point: verification changes
 * the account (it becomes `ACTIVE`), while sign-in changes nothing at all and only
 * starts a session.
 *
 * Step 19 adds the second consequence of verification: it provisions the wallet. That call
 * is inside `verifyOtp`, below the transaction that activates the user, and the note there
 * is the long version of why it sits exactly there and why it cannot change the answer.
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
    private readonly tokens: TokenService,
    /**
     * The one wallet dependency in this bounded context, and the direction of the import is
     * deliberate: identity does not hold key material or talk to Horizon, it *asks* the
     * wallet module for the thing Step 19 describes - "a funded account, once the phone
     * number is verified" - and `WalletModule` is the module that knows how.
     */
    private readonly provisioning: AccountProvisioningService,
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

    /**
     * The handle is settled *before* the request is counted, for the same reason the
     * existence check above is: an invalid or already-taken handle costs no SMS, so
     * it must not spend this number's allowance. `existing?.id` is passed as the
     * current holder so that a number re-registering with the handle it already
     * holds is not a conflict with itself.
     */
    const handle =
      dto.handle === undefined ? undefined : await this.resolveHandle(dto.handle, existing?.id);

    // Counted before the user row is created, so a blocked request leaves nothing
    // behind: an over-limit caller gets no row, no code and no SMS.
    await this.assertWithinRequestLimit(phoneNumber);

    const user = await this.claimAccount(phoneNumber, handle, existing);

    const { code, expiresAt } = await this.otp.issue(user.id);
    await this.sendOtp(phoneNumber, code);

    return {
      userId: user.id,
      phoneNumber,
      status: user.status,
      handle: user.handle,
      // ISO-8601 on the wire, matching `HealthResponseDto.timestamp`: the
      // response body holds a string, so the DTO does too, and the conversion
      // happens at the boundary that computed the value.
      expiresAt: expiresAt.toISOString(),
      codeLength: this.config.getOrThrow<number>('otp.codeLength'),
    };
  }

  /**
   * Creates the account, or applies a handle to the pending one, and reports which
   * field a lost race was about.
   *
   * Two things happen on a resend that are worth naming. The row is reused, so the
   * user id survives and the code issued below replaces the previous one - that is
   * Step 14's behaviour, unchanged. And a handle submitted on the resend *is*
   * applied: someone who mistyped their handle and asked for a new code should not
   * have to invent a second phone number to fix it. That is safe because the handle
   * was checked against this user's own id, so re-submitting the same handle is a
   * no-op rather than a conflict.
   *
   * Both writes can lose a race with a concurrent registration for the same handle
   * or the same number. The unique index is what decides, and the loser is told
   * which field was already taken - see `toRegistrationConflict`.
   */
  private async claimAccount(
    phoneNumber: string,
    handle: string | undefined,
    existing: RegisteredUser | null,
  ): Promise<RegisteredUser> {
    try {
      if (existing === null) {
        return await this.prisma.user.create({
          // `status` is left to the column default (`PENDING_VERIFICATION`) rather
          // than restated here: a create path that spells it out is a create path
          // that can later spell it out wrongly.
          //
          // `handle` is `undefined` when none was submitted, which Prisma reads as
          // "column not provided" - it stays NULL rather than becoming an empty
          // string, so "no handle" has exactly one representation.
          data: { phoneNumber, handle },
        });
      }

      if (handle === undefined || existing.handle === handle) {
        return existing;
      }

      return await this.prisma.user.update({ where: { id: existing.id }, data: { handle } });
    } catch (error) {
      throw this.toRegistrationConflict(error, handle);
    }
  }

  /**
   * Turns a unique-index violation into the 409 the caller can act on.
   *
   * `meta.target` is read rather than assuming the handle was the culprit: the write
   * above collides on either `phone_number` or `handle`, and telling someone their
   * handle is taken when it was their number sends them to the wrong part of the
   * form. Anything that is not a `P2002` is rethrown untouched, so a genuine
   * database failure is still a 500 and still reaches Sentry.
   */
  private toRegistrationConflict(error: unknown, handle: string | undefined): Error {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return error instanceof Error ? error : new Error(String(error));
    }

    const target = Array.isArray(error.meta?.target) ? error.meta.target.map(String) : [];

    if (handle !== undefined && target.includes('handle')) {
      return new ConflictException(`@${handle} is already taken. Try a different handle.`);
    }

    return new ConflictException(
      'That number is already registered. Verify with a code instead, or use a different number.',
    );
  }

  /**
   * Returns the canonical handle, or refuses the request with a reason.
   *
   * Shape first, then availability: a handle that can never be valid is a 400
   * whatever the database happens to contain, and answering "taken" for something
   * like `@@adm in` would be a lie about a name that was never a candidate.
   *
   * The availability lookup is a *courtesy*, not the guarantee - two requests can
   * pass it in the same instant, and the unique index is what actually decides (see
   * `claimAccount`). It exists so the ordinary case, someone typing a handle that is
   * already gone, gets a clean 409 instead of a race.
   */
  private async resolveHandle(input: string, ownerId?: string): Promise<string> {
    let handle: string;

    try {
      handle = assertHandleAllowed(input);
    } catch (error) {
      throw this.toHandleRejection(error, input);
    }

    const holder = await this.prisma.user.findUnique({ where: { handle }, select: { id: true } });

    if (holder !== null && holder.id !== ownerId) {
      throw new ConflictException(`@${handle} is already taken. Try a different handle.`);
    }

    return handle;
  }

  /**
   * A refused handle is a 400 whose message names the rule that was broken.
   *
   * One message per reason rather than one generic one: "a handle needs at least 3
   * characters" tells the user what to type next, while "invalid handle" ends the
   * signup. Reserved is a 400 rather than a 409 even though it reads like "taken":
   * a taken handle can be freed, a reserved one never will be, so waiting and
   * retrying is not a thing the caller can do - it is the same class of answer as a
   * bad character, not a conflict to resolve.
   */
  private toHandleRejection(error: unknown, input: string): Error {
    if (!(error instanceof InvalidHandleError)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    switch (error.problem) {
      case 'too_short':
        return new BadRequestException(
          `A handle needs at least ${HANDLE_MIN_LENGTH} characters. "${input}" has ${error.handle.length}.`,
        );

      case 'too_long':
        return new BadRequestException(
          `A handle can be at most ${HANDLE_MAX_LENGTH} characters. "${input}" has ${error.handle.length}.`,
        );

      case 'characters':
        return new BadRequestException(
          'A handle can only contain letters, digits and underscores, like "miriam_owusu".',
        );

      case 'reserved':
        return new BadRequestException(
          `"@${error.handle}" is reserved by Cashping. Please choose another handle.`,
        );
    }
  }

  /**
   * Verifies a code and activates the account (Step 14), and starts a session
   * (Step 16).
   *
   * Outcomes:
   *   - no user for the number           -> 404;
   *   - already `ACTIVE`                 -> 409;
   *   - no live code / wrong / expired   -> 400;
   *   - out of attempts                  -> 429 (the code is dead, ask for a new one);
   *   - correct                          -> 200, `ACTIVE` with `phoneVerifiedAt` and a
   *                                        token pair.
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

    const outcome = await this.checkCode(user.id, dto.code);

    const verifiedAt = new Date();

    /**
     * Both writes are one fact - this code proved this number - so they share a
     * transaction. Consuming the code and activating the user separately would
     * leave a window in which a crash produced an unverified user whose code was
     * already spent, or (worse) an activated user whose code could still be
     * presented again.
     */
    await this.prisma.$transaction(async (tx) => {
      await this.consumeCode(tx, outcome.otpId, verifiedAt);

      await tx.user.update({
        where: { id: user.id },
        data: { status: UserStatus.ACTIVE, phoneVerifiedAt: verifiedAt },
      });
    });

    /**
     * The row read above is patched with the status the transaction just wrote, rather
     * than re-read: a third query would only be asking the database to confirm this
     * line, and `TokenService.issue` reads nothing but the id.
     */
    const session: SessionUser = { ...user, status: UserStatus.ACTIVE };

    /**
     * Step 19: the wallet, for a user who has just proved their number.
     *
     * **After the commit, never inside it.** Provisioning creates a key at KMS, calls a
     * faucet over HTTP and submits a transaction to Horizon - a database transaction held
     * open across those calls holds its row locks for as long as a public Testnet faucet
     * feels like taking, and a crash inside it would roll back *verification* because a
     * third party was slow. `status = ACTIVE` and `phone_verified_at` are the facts that
     * make this user a customer; the wallet is a consequence of them, not a condition.
     *
     * **Awaited, and still unable to change the answer.** Awaited because a floating
     * promise in a request handler is a failure nobody ever sees and an unhandled
     * rejection waiting to happen. Unable to change the answer because `provisionFor`
     * reports every failure as an outcome rather than as an exception - and the reason is
     * this exact call site: the OTP has been spent by the transaction above, so a client
     * that retries cannot succeed, and an error response here would tell a user they
     * failed at the one thing they just did successfully.
     *
     * The outcome is not in the response. Step 20's balance endpoint is where a client
     * learns what its wallet holds, and a client that could read a provisioning stage out
     * of *this* body would be a client that branches on the state of the chain - which is
     * the wrong place to put it, because a failed attempt is retried by the service that
     * knows how, not by a user who cannot.
     */
    const wallet = await this.provisioning.provisionFor(user.id);

    const issued = await this.tokens.issue(session);

    this.logger.log(
      `Phone verified for ${maskPhoneNumber(phoneNumber)} (user ${user.id}); ${describeWallet(wallet)}`,
    );

    return {
      ...this.toTokenPair(issued),
      userId: user.id,
      phoneNumber,
      status: UserStatus.ACTIVE,
      phoneVerifiedAt: verifiedAt.toISOString(),
    };
  }

  /**
   * Texts a sign-in code to a number that already has an account (Step 16).
   *
   * This is the piece `POST /auth/login` needs and registration cannot provide: a code
   * is issued by `register`, but verification *spends* it, and by the time a user comes
   * back the account is `ACTIVE` - so `register` answers 409 and there is no live code
   * left to check. Without this endpoint, signing in on a new device would only be
   * possible with a code that has already been used.
   *
   * A number with no account is refused with a 404 rather than answered with a silent
   * 200 ("a code is on its way, if the account exists"). That is deliberate: the silent
   * version leaves someone who mistyped their number waiting for an SMS that is never
   * coming, and it hides nothing anyway, because `register` already answers differently
   * for a verified number (409) than for a free one. What limits a scan of numbers is a
   * limit per *caller*, and Step 13's limiter is per number - extending it is Step 17's
   * work, not a reason to trade this away.
   */
  async requestLoginCode(dto: SubmittedPhoneNumberDto): Promise<LoginCodeResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    const user = await this.findSignInAccount(phoneNumber);

    /**
     * Counted after every check, which is `register`'s ordering and its reason unchanged:
     * a request that sends no SMS must not spend the number's allowance, or a wrong
     * number typed three times would lock the real user out of receiving codes at all.
     */
    await this.assertWithinRequestLimit(phoneNumber);

    const { code, expiresAt } = await this.otp.issue(user.id);
    await this.sendOtp(phoneNumber, code);

    return {
      phoneNumber,
      expiresAt: expiresAt.toISOString(),
      codeLength: this.config.getOrThrow<number>('otp.codeLength'),
    };
  }

  /**
   * Signs in with a code and starts a session (Step 16).
   *
   * Outcomes, in the order they are decided:
   *   - no user for the number           -> 404;
   *   - `SUSPENDED`                      -> 403, before a code is even looked at;
   *   - not `ACTIVE` yet                 -> 409, registration is unfinished;
   *   - no live code / wrong / expired   -> 400;
   *   - out of attempts                  -> 429 (the code is dead, ask for a new one);
   *   - already spent                    -> 409;
   *   - correct                          -> 200 with a token pair.
   *
   * The code is spent *before* the session exists, and the order matters. The other way
   * round - issue the tokens, then spend the code - leaves a live session behind if the
   * second write fails, and a session the user was never handed is worse than a spent
   * code: the code can be replaced with one SMS, while a live session nobody claims is
   * an open door. What this order costs is that a failure between the two writes sends
   * the user back to "ask for a new code", which is the failure a retry fixes.
   *
   * Nothing about the user row is written here. `phoneVerifiedAt` records when the
   * *number* was proven, and re-stamping it on every sign-in would be a lie about that;
   * a `lastLoginAt` column is not added either, because "when did this user last sign
   * in" is a question the refresh-token rows already answer - per session, and with the
   * device's own token to tell the sessions apart.
   */
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    const user = await this.findSignInAccount(phoneNumber);

    const outcome = await this.checkCode(user.id, dto.code);

    /**
     * `this.prisma` rather than a transaction: there is exactly one write here (the
     * conditional update that spends the code), so a transaction would add a round trip
     * to a set of statements that has nothing to roll back. Verification needs one
     * because it writes two rows that must agree; sign-in does not.
     */
    await this.consumeCode(this.prisma, outcome.otpId, new Date());

    const issued = await this.tokens.issue(user);

    this.logger.log(`Code sign-in for ${maskPhoneNumber(phoneNumber)} (user ${user.id})`);

    return {
      ...this.toTokenPair(issued),
      userId: user.id,
      phoneNumber,
      status: user.status,
      handle: user.handle,
    };
  }

  /**
   * Exchanges a refresh token for a new token pair (Step 16).
   *
   * The whole of the decision - the hashed lookup, reuse detection, expiry, account
   * status, rotation - belongs to `TokenService.rotate`, which answers with the status
   * codes itself. What is left here is the mapping to the wire, and it is the same
   * mapping `verifyOtp` and `login` use: one place decides what a token pair looks like
   * in a response body.
   *
   * No profile is returned with the pair, unlike login and verification. A client that
   * is refreshing already has a session and is asking for a longer one; if it needs the
   * user, `GET /auth/session` reads the row - not the token - so a handle changed on
   * another device shows up without a sign-in.
   */
  async refresh(dto: RefreshTokenDto): Promise<TokenPairResponseDto> {
    const issued = await this.tokens.rotate(dto.refreshToken);

    return this.toTokenPair(issued);
  }

  /**
   * Ends the session the presented refresh token belongs to (Step 16).
   *
   * One session, not all of them: a user with a phone and a tablet holds two refresh
   * tokens, and signing out on one must not sign them out of the other. "Sign out
   * everywhere" is a different feature with a different route, and it is the one that
   * will call `TokenService.revokeAllForUser`.
   */
  async logout(dto: RefreshTokenDto): Promise<void> {
    const revoked = await this.tokens.revoke(dto.refreshToken);

    /**
     * Logged either way, because "why was I signed out?" is the question this line
     * answers, and because a client that logs out with a token which revokes nothing is a
     * bug worth seeing in a log - it is also exactly what a client that never stored the
     * rotated token looks like.
     *
     * Nothing is logged about *which* user: the token is anonymous by the time it
     * reaches here, and looking the row up only to name a user in a log line would make
     * signing out cost a query.
     */
    this.logger.log(
      revoked
        ? 'Refresh token revoked on logout.'
        : 'Logout presented a refresh token that was not live; nothing to revoke.',
    );
  }

  /**
   * Reports who the caller is (Step 16).
   *
   * The row `JwtStrategy` has just read, mapped to the wire. It takes the user rather
   * than an id because the read has already happened by the time a handler runs: asking
   * the database again here would be a second answer to a question that was just
   * answered, and the two could disagree under a concurrent update.
   */
  session(user: SessionUser): SessionResponseDto {
    return {
      userId: user.id,
      phoneNumber: user.phoneNumber,
      status: user.status,
      handle: user.handle,
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

  /**
   * Finds the account a sign-in is about, or answers why it cannot be signed in to.
   *
   * Shared by both sign-in endpoints - "text me a code" and "here is the code" - because
   * both have to answer the same questions about the number first, and the answers have
   * to be identical. Two copies of this is how "send me a code" starts telling a
   * suspended user something different from "sign me in".
   *
   * The order is the order the caller can act on. An unknown number is a 404, because
   * the call to action is register. A suspended account is a 403 and is checked *before*
   * the code, so a suspended user is not told their code was wrong and sent to ask for
   * another one that will not work either. An account still awaiting verification is a
   * 409, because registration is unfinished rather than refused.
   *
   * `ACTIVE` is the only status that gets through, and the check is written as
   * `!== ACTIVE` rather than as a list of the refused ones: a status added to the enum
   * later must not quietly become sign-in-able.
   */
  private async findSignInAccount(phoneNumber: string): Promise<UserModel> {
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user === null) {
      throw new NotFoundException(
        'No account is registered for that number. Register first, then sign in.',
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ConflictException(
        'That number has not been verified yet. Finish registering, then sign in.',
      );
    }

    return user;
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

  /**
   * Checks a submitted code against the live one, or throws the reason it failed.
   *
   * Shared by verification and sign-in, which is the point of it: the same rules apply to
   * both (one live code per number, a bounded number of wrong guesses, a real lifetime),
   * and a user who mistypes on the sign-in screen has to get the answer they would have
   * got on the verification screen - not a different one because a second copy of the
   * rules drifted. `OtpService` owns the rules; this turns its outcome into a response.
   *
   * The outcome is returned rather than only being asserted, because both callers need
   * `otpId` to spend the exact row that was just checked.
   */
  private async checkCode(
    userId: string,
    code: string,
  ): Promise<Extract<OtpCheckOutcome, { ok: true }>> {
    const outcome = await this.otp.check(userId, code);

    if (!outcome.ok) {
      throw this.toHttpException(outcome);
    }

    return outcome;
  }

  /**
   * Spends a live code, or refuses because it was spent already.
   *
   * The client to run on is a parameter rather than `this.prisma`, so that verification
   * can spend the code *inside* the transaction that also activates the account: a
   * consumed code with the user left unverified (or the reverse) is a state nothing can
   * move forward from - the code is gone and the account cannot be activated.
   *
   * `consumedAt: null` in the filter is what makes that safe, and it is why this is an
   * `updateMany` and not an `update`. The row was live when it was checked and may not be
   * any more - the same person double-tapping "verify", or two devices racing with the
   * same code. The loser gets `count === 0` and a clear refusal instead of both requests
   * being told they succeeded.
   */
  private async consumeCode(
    client: Prisma.TransactionClient,
    otpId: string,
    consumedAt: Date,
  ): Promise<void> {
    const { count } = await client.otpVerification.updateMany({
      where: { id: otpId, consumedAt: null },
      data: { consumedAt },
    });

    if (count === 0) {
      throw new ConflictException('That code has already been used. Request a new one.');
    }
  }

  /**
   * Maps freshly issued tokens onto the response body.
   *
   * One place, because three endpoints return the same shape and the only interesting
   * decision inside it is the conversion from `Date` to ISO-8601 string: the DTOs hold
   * strings, as every other timestamp in this API does, and this is the boundary that
   * knows how fresh dates were produced.
   */
  private toTokenPair(issued: IssuedTokens): TokenPairResponseDto {
    return {
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
    };
  }
}
