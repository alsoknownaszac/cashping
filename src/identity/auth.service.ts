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
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CountryCode } from 'libphonenumber-js';
import { AuditService } from '../audit/audit.service.js';
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
import { type ChangeHandleDto } from './dto/change-handle.dto.js';
import { type ConfirmPinResetDto } from './dto/confirm-pin-reset.dto.js';
import { type ChangePinDto } from './dto/change-pin.dto.js';
import { type HandleResponseDto } from './dto/handle-response.dto.js';
import { hashSecret } from './credentials/secret-hash.js';
import { type LoginCodeResponseDto } from './dto/login-code-response.dto.js';
import { type LoginDto, type LoginResponseDto } from './dto/login.dto.js';
import { type SubmittedPhoneNumberDto } from './dto/phone-number.dto.js';
import { type RefreshTokenDto } from './dto/refresh-token.dto.js';
import { type RegisterDto } from './dto/register.dto.js';
import { type RegisterResponseDto } from './dto/register-response.dto.js';
import { type SessionResponseDto } from './dto/session-response.dto.js';
import { type PinChangeResponseDto } from './dto/pin-change-response.dto.js';
import { type PinVerifyResponseDto } from './dto/pin-verify-response.dto.js';
import { type TokenPairResponseDto } from './dto/token-pair-response.dto.js';
import { type VerifyOtpDto } from './dto/verify-otp.dto.js';
import { type VerifyOtpResponseDto } from './dto/verify-otp-response.dto.js';
import { type VerifyPinDto } from './dto/verify-pin.dto.js';
import { type ChangePasswordDto } from './dto/change-password.dto.js';
import { type ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto.js';
import { type EmailSetResponseDto } from './dto/email-set-response.dto.js';
import { type EmailVerifyResponseDto } from './dto/email-verify-response.dto.js';
import { type LoginPasswordDto } from './dto/login-password.dto.js';
import { type PasswordSetResponseDto } from './dto/password-set-response.dto.js';
import { type SetEmailDto } from './dto/set-email.dto.js';
import { type VerifyEmailDto } from './dto/verify-email.dto.js';
import {
  InvalidEmailAddressError,
  MAX_EMAIL_LENGTH,
  maskEmailAddress,
  normalizeEmailAddress,
} from './email/email-address.js';
import {
  EmailService,
  type EmailSetRefusal,
  type EmailVerifyRefusal,
} from './email/email.service.js';
import { PasswordService, type PasswordChangeRefusal } from './password/password.service.js';
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
import { PinService, type PinChangeRefusal } from './pin/pin.service.js';
import { StepUpTokenService } from './pin/step-up-token.service.js';
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
 * The identifier a password sign-in was submitted with, and the column it belongs to (Step 34c).
 *
 * The type is where the decision is recorded, because every use of an identifier - the lookup,
 * the rate-limit subject, the log line - has to agree about which of the two it is holding. A
 * bare `string` would let the one that logs call the phone mask on an address, and it would let
 * the one that queries look in `phoneNumber` for an address. `masked` travels with the value
 * rather than being computed at each use for the same reason: which mask is honest is a fact
 * about the field, not about the caller.
 */
interface SignInIdentifier {
  /** The unique column it came from, and therefore the lookup to run. */
  readonly field: 'phoneNumber' | 'email';
  /** The normalized value: strict E.164, or the trimmed, lower-cased address. */
  readonly value: string;
  /** The only spelling of it a log line may carry. */
  readonly masked: string;
}

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
 *
 * Step 34a adds a third kind of credential to this service: `changePin` sets or changes the
 * transaction PIN, and `verifyPin` proves it and mints the short-lived step-up token that
 * `POST /v1/payments` requires. The PIN's own rules - the hash, the attempt counter, the
 * lockout - belong to `PinService`, and what belongs *here* is the HTTP mapping, which for
 * one fact is two answers: a wrong PIN is a 401 on the step-up endpoint (the credential was
 * not accepted) and a 409 on the change endpoint (there is a conflict to resolve, and the
 * message names how many attempts are left).
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
    /**
     * Step 32's append-only record of what was *asked*, as opposed to what money did.
     *
     * Injected rather than reached through an interceptor, and the reason is visible in what the
     * entries need: every one of the three this service writes is keyed by a user id that only
     * these methods hold, and two of them (`user.handle.set` with its source, and
     * `auth.otp.verified`) describe facts that no request-level view of `POST /auth/*` can see.
     * `AuditModule`'s docstring records the split; `AuditService` records why a failed write is
     * swallowed instead of being allowed to fail a sign-in.
     */
    private readonly audit: AuditService,
    /**
     * The transaction PIN (Step 34a): the set/change/verify rules, the attempt counter and
     * the lockout.
     *
     * Injected rather than reimplemented, and the boundary is deliberate - `PinService`
     * never sees a `SessionUser`, an HTTP exception or a status code, so the only thing
     * this service contributes is which answer each outcome becomes over HTTP. That is what
     * lets the same "wrong PIN" outcome be a 401 here and a 409 there.
     */
    private readonly pins: PinService,
    /**
     * The step-up token (Step 34a): minted here when `verifyPin` succeeds, and verified by
     * `StepUpAuthGuard` in front of `POST /v1/payments`.
     *
     * A service of its own rather than a method on `TokenService`, because it is a
     * different credential with a different lifetime and audience - and one shared signing
     * secret is exactly why the audience has to be stated on both sides.
     */
    private readonly stepUpTokens: StepUpTokenService,
    /**
     * The password (Step 34b): the set/change/verify rules, and the hashing that goes with
     * them.
     *
     * Injected rather than reimplemented, exactly as `PinService` is, and for the same reason:
     * it decides no status codes and never sees a `SessionUser`, so the only thing this
     * service adds is which answer each outcome becomes over HTTP.
     */
    private readonly passwords: PasswordService,
    /**
     * The email address (Step 34c): attaching one and confirming it, and the verification
     * code that goes with it.
     *
     * Injected rather than reimplemented. It does not *send* anything - the code comes back
     * here and goes out through `NotificationsService`, so the wording and the transport stay
     * behind the notification seam and this method is the one place a set is both written and
     * delivered.
     */
    private readonly emails: EmailService,
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

    /**
     * The PIN is hashed *here*, before any write and outside the transaction (there is none
     * yet), and it cannot be a source of failures: when one was supplied its shape was settled
     * by `RegisterDto` (four digits, or a 400 before this method was reached), and scrypt does
     * not care which four digits they are. It is computed before the request is counted because
     * it is not a request the number's allowance should pay for - it touches no network and no row.
     *
     * The hash goes into `claimAccount` rather than being written afterwards, so the account
     * never exists without the credential its first payment will require - *unless the client
     * deferred it* (Step 34d): then there is nothing to hash, the account is created with a null
     * PIN, and `POST /auth/pin/change` installs one later through its own `set` path.
     */
    const transactionPinHash = dto.pin === undefined ? undefined : await hashSecret(dto.pin);

    // Counted before the user row is created, so a blocked request leaves nothing
    // behind: an over-limit caller gets no row, no code and no SMS.
    await this.assertWithinRequestLimit(phoneNumber);

    const user = await this.claimAccount(phoneNumber, handle, existing, transactionPinHash);

    /**
     * Step 32: `user.handle.set`, written here - before the code is issued and the SMS sent -
     * because the fact it records has already happened by this line: the row exists with this
     * handle. That is true whether or not the send below succeeds, and an entry written after
     * `sendOtp` would claim the handle was never set when the only thing that failed was an SMS.
     *
     * `metadata.source` is the useful half: 'registration' is a first claim, 'resend' is the
     * `PENDING_VERIFICATION` path reusing the row, and a handle that changed hands is visible as
     * two entries with different values for one user id.
     */
    await this.audit.log({
      action: 'user.handle.set',
      userId: user.id,
      outcome: 'ok',
      metadata: { handle: user.handle, source: existing === null ? 'registration' : 'resend' },
    });

    /**
     * Step 34a: `auth.pin.set`, written beside the handle entry - but only when a PIN was
     * actually supplied at this step (the PIN is optional here). `metadata.source` carries the
     * same split the handle entry records, so "a PIN was chosen at registration" and "a PIN was
     * chosen on a resend" are distinguishable in the trail without a second literal.
     *
     * A deferred PIN is deliberately not logged here: no PIN was set, and an entry claiming one
     * was would be a lie in the trail. The `set` entry for a PIN installed later comes from
     * `PinService.change`, where that write really happens.
     *
     * What is deliberately absent: the PIN, and its hash. A row that recorded either would
     * make the audit table a place secrets live, which is the one thing `AuditService`
     * forbids in as many words.
     */
    if (transactionPinHash !== undefined) {
      await this.audit.log({
        action: 'auth.pin.set',
        userId: user.id,
        outcome: 'ok',
        metadata: { source: existing === null ? 'registration' : 'resend' },
      });
    }

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
    transactionPinHash: string | undefined,
  ): Promise<RegisteredUser> {
    /**
     * The PIN travels with the row when one was supplied (Step 34a), which is why it is one object
     * rather than four fields spelled out twice: "an account exists" and "it holds the PIN it was
     * registered with" are one fact, and a create path that wrote only one of them would produce
     * an account whose first payment fails for a reason the user cannot see.
     *
     * The PIN is optional at registration, so an account registered without one writes none of
     * these columns: the empty object spreads to nothing, the create path leaves the new row's
     * PIN columns at their defaults (null), and the resend path leaves a PIN the row already
     * holds untouched.
     *
     * `attempts` and `lockedUntil` are written explicitly rather than left to the column
     * defaults, because this is a *new* credential: a hash written over a row that somehow
     * carried a spent allowance would otherwise inherit it. The default would be right for a
     * freshly created row and wrong for a reused one, and one statement that is right on
     * both paths is worth more than two that differ.
     */
    const pin =
      transactionPinHash === undefined
        ? {}
        : {
            transactionPinHash,
            transactionPinSetAt: new Date(),
            transactionPinAttempts: 0,
            transactionPinLockedUntil: null,
          };

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
          data: { phoneNumber, handle, ...pin },
        });
      }

      /**
       * The pending row is reused (the resend path), and a PIN resubmitted with it is written
       * again. That is safe for exactly the reason reusing the row is safe at all: the account is
       * still unproven, and the code about to be sent is the proof that this is the same person -
       * so replacing a PIN here is the same act as registering one, and it gives a half-finished
       * signup nothing that a fresh one would not have. A resend that submits no PIN (Step 34d)
       * leaves whatever the row already holds in place.
       *
       * A handle that was not resubmitted, or resubmitted unchanged, is left alone:
       * `handle: undefined` means "column not provided" to Prisma. The previous early return
       * for that case is gone because a resubmitted PIN still has to be written here, and a
       * second branch that skipped the row would be one more path to keep in step.
       */
      return await this.prisma.user.update({
        where: { id: existing.id },
        data: { handle, ...pin },
      });
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
    /**
     * Step 32: `auth.otp.verified`, written after the transaction above has committed and before
     * provisioning is attempted.
     *
     * The placement is the point. Verification is already done - `phoneVerifiedAt` is set and the
     * code is spent in one transaction - so the entry must not wait on a Horizon round trip that
     * can take seconds, and an `incomplete` provisioning below must not leave the trail looking as
     * though nothing was verified. What is deliberately *not* here is the provisioning outcome:
     * that is what `provisionFor` logs in detail and what Step 20's balance endpoint reflects, and
     * a second copy of it in this table would be a copy that can disagree with the chain.
     */
    await this.audit.log({ action: 'auth.otp.verified', userId: user.id, outcome: 'ok' });

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

    /**
     * Step 32: `auth.login`, after the code has been spent *and* the token pair issued.
     *
     * `consumeCode` is what makes this a sign-in rather than a check on a live code, so the entry
     * follows it; it follows `tokens.issue` so that the row means "a session exists" rather than "a
     * session was about to". No phone number in `metadata` - the masked number in the log line
     * below is this codebase's disclosure rule for it, and the row's `user_id` already names the
     * account to anyone with a reason to be reading it.
     */
    await this.audit.log({ action: 'auth.login', userId: user.id, outcome: 'ok' });

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
   * Reports who the caller is, and how far through onboarding they have got (Step 16; the
   * onboarding block was added when the frontend needed it to choose its next screen).
   *
   * The four identity fields come from the row `JwtStrategy` has just read - no second read for
   * those. The onboarding block is a *different* set of facts the guard deliberately does not
   * carry: that read is on the hot path of every authenticated request and stays narrow (id,
   * number, status, handle), while this endpoint is called once on launch and is the only place
   * that needs a wallet's existence, a PIN's presence and the two verification instants. Reading
   * them here, in one primary-key lookup, is cheaper than making every request pay for a join
   * nine times in ten will not use.
   */
  async session(user: SessionUser): Promise<SessionResponseDto> {
    const onboarding = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        transactionPinHash: true,
        email: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        stellarAccount: { select: { id: true } },
      },
    });

    return {
      userId: user.id,
      phoneNumber: user.phoneNumber,
      status: user.status,
      handle: user.handle,
      // Every flag is `false` if the row is gone between the guard's read and this one: a session
      // whose account has just been deleted is not a session to invent onboarding facts for.
      onboarding: {
        hasWallet: onboarding?.stellarAccount != null,
        hasPin: onboarding?.transactionPinHash != null,
        hasEmail: onboarding?.email != null,
        emailVerified: onboarding?.emailVerifiedAt != null,
        phoneVerified: onboarding?.phoneVerifiedAt != null,
      },
    };
  }

  /**
   * Sets or changes the account's handle (the "handle change" endpoint).
   *
   * The same `resolveHandle` registration uses, so the shape rules and the availability check
   * cannot differ between claiming a handle at signup and changing it here - a handle typed on
   * this screen is refused with exactly the message signup would have given. `user.id` is passed
   * as the current owner, so re-submitting the handle the account already holds is a no-op
   * rather than a conflict with itself.
   *
   * The write can still lose a race with a concurrent claim of the same handle on another
   * account - the courtesy lookup above cannot see it - and the unique index is what decides, so
   * the `P2002` is turned into the same 409 a lost race at registration produces
   * (`toRegistrationConflict`).
   *
   * One audit entry, `user.handle.set`, with `metadata.source: 'change'`: the same literal
   * registration writes, because "a handle was set" is one fact and `source` is how the writers
   * are told apart in the trail.
   */
  async changeHandle(user: SessionUser, dto: ChangeHandleDto): Promise<HandleResponseDto> {
    const handle = await this.resolveHandle(dto.handle, user.id);

    try {
      await this.prisma.user.update({ where: { id: user.id }, data: { handle } });
    } catch (error) {
      throw this.toRegistrationConflict(error, handle);
    }

    await this.audit.log({
      action: 'user.handle.set',
      userId: user.id,
      outcome: 'ok',
      metadata: { handle, source: 'change' },
    });

    return { handle };
  }

  /**
   * Sets the transaction PIN, or changes it by proving the current one (Step 34a).
   *
   * The three failures are mapped apart on purpose. A missing `currentPin` and a wrong one
   * are both 409s - "this account already has a PIN and you have not proved it" is a state
   * conflict either way - while a locked PIN is a 429, because waiting is the action rather
   * than correcting the request.
   */
  async changePin(user: SessionUser, dto: ChangePinDto): Promise<PinChangeResponseDto> {
    const outcome = await this.pins.change(user.id, dto.currentPin, dto.pin);

    if (!outcome.ok) {
      throw this.toPinRejection(outcome, 'change');
    }

    return { pinSetAt: outcome.pinSetAt.toISOString() };
  }

  /**
   * Proves the transaction PIN and mints the step-up token a payment needs (Step 34a).
   *
   * The token is minted here rather than inside `PinService`, which knows nothing about
   * tokens, and it is returned in the body because that is the only way the client can
   * present it: setting a cookie would introduce a second authentication mechanism - with
   * its own CSRF story - to carry a value that lives for five minutes.
   *
   * Nothing about the PIN is in the response: not the digits, not the hash, and not the
   * attempt counter. A successful proof has no attempts left to report, and the failure path
   * is where that number belongs.
   */
  async verifyPin(user: SessionUser, dto: VerifyPinDto): Promise<PinVerifyResponseDto> {
    const outcome = await this.pins.verify(user.id, dto.pin);

    if (!outcome.ok) {
      throw this.toPinRejection(outcome, 'verify');
    }

    const issued = await this.stepUpTokens.issue(user.id);

    return {
      stepUpToken: issued.token,
      stepUpTokenExpiresAt: issued.expiresAt.toISOString(),
    };
  }

  /**
   * Turns a refused PIN into the answer the caller can act on.
   *
   * The status depends on the *endpoint* as well as on the outcome, which is why this takes
   * the context rather than living in `PinService`: `invalid_pin` is a 401 on the step-up
   * call (a credential was presented and not accepted) and a 409 on a change (the account's
   * PIN is not the one the caller thinks it is). `locked` is a 429 either way - the caller
   * has to wait, and the message says until when - and `not_set` is a 409, because nothing
   * was refused: there is simply no PIN to prove yet, which is the state a Google-SSO
   * account starts in (Step 34d).
   */
  private toPinRejection(outcome: PinChangeRefusal, context: 'verify' | 'change'): HttpException {
    switch (outcome.reason) {
      case 'current_pin_required':
        return new ConflictException(
          'This account already has a PIN. Send currentPin to change it.',
        );

      case 'not_set':
        return new ConflictException(
          'No transaction PIN is set for this account. Set one with POST /auth/pin/change.',
        );

      case 'invalid_pin':
        return context === 'verify'
          ? new UnauthorizedException(
              `That PIN is not correct. ${outcome.attemptsRemaining} attempts remaining.`,
            )
          : new ConflictException(
              `That current PIN is not correct. ${outcome.attemptsRemaining} attempts remaining.`,
            );

      case 'locked':
        return new HttpException(
          `Too many incorrect PIN attempts. Try again after ${outcome.lockedUntil.toISOString()}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
    }
  }

  /**
   * Sets or changes the account password (Step 34b).
   *
   * The status codes are the same split the PIN's change uses: a missing or wrong
   * `currentPassword` is a 409 - there is a conflict to resolve, and the message names what to
   * send - rather than a 401, because the caller *is* authenticated and is being told what
   * their request lacked.
   */
  async changePassword(
    user: SessionUser,
    dto: ChangePasswordDto,
  ): Promise<PasswordSetResponseDto> {
    const outcome = await this.passwords.change(user.id, dto.currentPassword, dto.password);

    if (!outcome.ok) {
      throw this.toPasswordRejection(outcome);
    }

    return { passwordSetAt: outcome.passwordSetAt.toISOString() };
  }

  /**
   * Signs in with a password, and starts a session (Steps 34b and 34c).
   *
   * The identifier is the number the account registered with or the address it has *verified*
   * (Step 34c) - exactly one of the two, read by `signInIdentifier`, which also normalizes it. The
   * password is the same credential either way: there is one password column, not one per
   * identifier, so an address is a second way to *present* the credential rather than a second
   * credential.
   *
   * Outcomes, in the order they are decided:
   *   - both identifiers, or neither -> 400, before anything is looked up;
   *   - `SUSPENDED`                -> 403, before the password is even looked at;
   *   - over the attempt allowance -> 429 (the counter is the OTP limiter's, so a password
   *                                   guess is priced exactly like a code guess);
   *   - no account, no password set, wrong password, not `ACTIVE`, or an address that was never
   *     proved                     -> one 401;
   *   - otherwise                  -> 200 with the same token pair `POST /auth/login` answers.
   *
   * The single 401 is the point: "no such user", "no password set", "wrong password" and "that
   * address was never verified" are the same answer, for the reason `TokenService`'s refresh
   * failures share one message - the endpoint is otherwise an oracle that tells an anonymous
   * caller which numbers and addresses are registered, or which of them are claimed. The audit
   * row records which of them it was, and it is `denied` for all of them.
   *
   * The 400 for an ambiguous body is the one refusal that is *not* hidden, because it is about the
   * request rather than about an account: it names no account and cannot be used to probe one.
   */
  async loginWithPassword(dto: LoginPasswordDto): Promise<LoginResponseDto> {
    const refused =
      'That phone number or email and password do not match. Check them and try again.';

    const identifier = this.signInIdentifier(dto);

    const user = await this.findPasswordSignInUser(identifier);

    if (user !== null && user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    await this.assertWithinPasswordAttemptLimit(identifier);

    /**
     * An address has to have been *proved* before it can sign anyone in (Step 34c). A row whose
     * `emailVerifiedAt` is null holds an address that was attached and never confirmed, and such a
     * row is answered exactly as an address nothing holds - so this endpoint cannot be used to
     * find out which addresses are claimed, in the way the one 401 below stops it being used to
     * find out which numbers are registered. A number carries no such condition because
     * registration does not finish without proving it: `phoneVerifiedAt` is what makes a row
     * `ACTIVE`, whereas an address is attached to an account that is already active.
     *
     * `status` rules out `PENDING` and `SUSPENDED` too - the first has no password to check by
     * construction (`POST /auth/password/change` requires an `ACTIVE` session), and the second was
     * already refused above.
     */
    const signable =
      user !== null &&
      user.status === UserStatus.ACTIVE &&
      (identifier.field === 'phoneNumber' || user.emailVerifiedAt !== null);

    if (!signable) {
      await this.audit.log({ action: 'auth.password.login', userId: user?.id, outcome: 'denied' });

      throw new UnauthorizedException(refused);
    }

    if (!(await this.passwords.verify(user.id, dto.password))) {
      await this.audit.log({ action: 'auth.password.login', userId: user.id, outcome: 'denied' });

      throw new UnauthorizedException(refused);
    }

    const issued = await this.tokens.issue(user);

    await this.audit.log({ action: 'auth.password.login', userId: user.id, outcome: 'ok' });

    this.logger.log(`Password sign-in for ${identifier.masked} (user ${user.id})`);

    return {
      ...this.toTokenPair(issued),
      userId: user.id,
      // The account's own number, not the submitted one. They are the same value when the number
      // was the identifier, and when it was the address this is the only spelling the account has
      // for it.
      phoneNumber: user.phoneNumber,
      status: user.status,
      handle: user.handle,
    };
  }

  /**
   * Starts a forgot-password reset by texting a code (Step 34b).
   *
   * Answers 202 whether or not the number belongs to an account, and the *response* must not
   * tell an anonymous caller which numbers are registered: without that, this endpoint is an
   * enumeration oracle that the sign-in endpoint deliberately is not. Both paths therefore run
   * the same code up to the point where one has a row - an account gets a code and an SMS, an
   * unknown number gets neither - and the two answers are byte-identical because the second is
   * computed (`now + ttl`) rather than read from a row that does not exist.
   *
   * The send is counted only when it really happens (`register`'s ordering, unchanged): a
   * request for an unknown number must not spend that number's allowance.
   */
  async requestPasswordReset(dto: SubmittedPhoneNumberDto): Promise<LoginCodeResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);
    const codeLength = this.config.getOrThrow<number>('otp.codeLength');
    const ttlMinutes = this.config.getOrThrow<number>('otp.ttlMinutes');

    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user !== null && user.status === UserStatus.ACTIVE) {
      await this.assertWithinRequestLimit(phoneNumber);

      const { code, expiresAt } = await this.otp.issue(user.id);

      await this.sendOtp(phoneNumber, code);

      /**
       * Written only when a code was really sent. A request for an unknown number changes
       * nothing, so there is no event to record - and recording one keyed to nothing would
       * make the table a log of *attempts against unknown numbers*, which is a shape nobody
       * asked for and one more place a number could be inferred from.
       */
      await this.audit.log({
        action: 'auth.password.reset.requested',
        userId: user.id,
        outcome: 'ok',
      });

      return { phoneNumber, expiresAt: expiresAt.toISOString(), codeLength };
    }

    return {
      phoneNumber,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      codeLength,
    };
  }

  /**
   * Finishes a reset: checks the code and writes the new password (Step 34b).
   *
   * The code is checked and spent exactly as it is at verification and sign-in - the same
   * `checkCode`/`consumeCode` pair, so the expiry, attempt and single-use rules cannot drift -
   * and a wrong, expired or exhausted code is answered with the same 400/429 the OTP endpoints
   * use. The code is spent *before* the password is written, so a double-tapped confirm cannot
   * write twice: the second call fails the compare-and-set and changes nothing.
   */
  async confirmPasswordReset(dto: ConfirmPasswordResetDto): Promise<PasswordSetResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user === null) {
      // The same 400 a live code lookup would give, rather than a 404: whether the number
      // exists is not something an unauthenticated reset endpoint should answer.
      throw new BadRequestException(
        'No verification code is outstanding for this number. Request a new one.',
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    const outcome = await this.checkCode(user.id, dto.code);

    await this.consumeCode(this.prisma, outcome.otpId, new Date());

    const passwordSetAt = await this.passwords.set(user.id, dto.newPassword);

    await this.audit.log({
      action: 'auth.password.reset.completed',
      userId: user.id,
      outcome: 'ok',
    });

    return { passwordSetAt: passwordSetAt.toISOString() };
  }

  /**
   * Starts a forgot-PIN reset by texting a code.
   *
   * The same shape and the same guarantee as `requestPasswordReset`: 202 whether or not the
   * number belongs to an account, and a byte-identical body either way, so this endpoint is not
   * an existence oracle. The reset reuses the OTP machinery - a reset code is an OTP with a
   * different purpose, not a second code system - so its lifetime, attempt count and single-use
   * rules are the ones every other code already has, and the send is counted only when it really
   * happens (an unknown number spends no allowance).
   *
   * The PIN cannot be *proved* by someone who has forgotten it, so the phone number is the whole
   * of the proof here: whoever can read the code is taken to be the account holder, exactly as
   * the password reset already assumes.
   */
  async requestPinReset(dto: SubmittedPhoneNumberDto): Promise<LoginCodeResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);
    const codeLength = this.config.getOrThrow<number>('otp.codeLength');
    const ttlMinutes = this.config.getOrThrow<number>('otp.ttlMinutes');

    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user !== null && user.status === UserStatus.ACTIVE) {
      await this.assertWithinRequestLimit(phoneNumber);

      const { code, expiresAt } = await this.otp.issue(user.id);

      await this.sendOtp(phoneNumber, code);

      await this.audit.log({
        action: 'auth.pin.reset.requested',
        userId: user.id,
        outcome: 'ok',
      });

      return { phoneNumber, expiresAt: expiresAt.toISOString(), codeLength };
    }

    return {
      phoneNumber,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      codeLength,
    };
  }

  /**
   * Finishes a forgot-PIN reset: checks the code and writes the new PIN.
   *
   * The code is checked and spent exactly as it is at verification, sign-in and the password
   * reset - the same `checkCode`/`consumeCode` pair - so its rules cannot drift from the rest of
   * the app, and it is spent *before* the PIN is written so a double-tapped confirm cannot write
   * twice: the second call fails the compare-and-set and changes nothing.
   *
   * The write itself is `PinService.reset`, the one path to a PIN that proves the old one was not
   * needed because possession of the phone was proved instead.
   */
  async confirmPinReset(dto: ConfirmPinResetDto): Promise<PinChangeResponseDto> {
    const phoneNumber = this.normalize(dto.phoneNumber);

    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (user === null) {
      // The same 400 a live code lookup would give, rather than a 404: whether the number
      // exists is not something an unauthenticated reset endpoint should answer.
      throw new BadRequestException(
        'No verification code is outstanding for this number. Request a new one.',
      );
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account is suspended. Contact support.');
    }

    const outcome = await this.checkCode(user.id, dto.code);

    await this.consumeCode(this.prisma, outcome.otpId, new Date());

    const pinSetAt = await this.pins.reset(user.id, dto.pin);

    await this.audit.log({
      action: 'auth.pin.reset.completed',
      userId: user.id,
      outcome: 'ok',
    });

    return { pinSetAt: pinSetAt.toISOString() };
  }

  /**
   * Attaches (or replaces) the account's email address and sends a verification code
   * (Step 34c).
   *
   * The address is normalized (trimmed, lower-cased) and the shape rule is enforced before
   * anything is written, so a malformed address is a 400 that names the rule it broke rather
   * than an anonymous "invalid email". The write and the code belong to `EmailService`; what
   * belongs *here* is turning the code into a delivery - through `NotificationsService`, so
   * the wording and the transport stay behind the notification seam.
   *
   * The delivery is counted against the address's allowance first (`assertWithinEmailSendLimit`),
   * which makes this the one endpoint whose *send* is capped rather than its *lookup*: every other
   * send in this service is a text to a number, counted on that number by the endpoint that sends it
   * (`register`, `requestLoginCode`, `requestPasswordReset`). The ordering of that count is the one
   * decision worth stating - after every refusal, before the delivery - and it is argued where it is
   * made.
   */
  async setEmail(user: SessionUser, dto: SetEmailDto): Promise<EmailSetResponseDto> {
    const email = this.normalizeEmail(dto.email);

    const outcome = await this.emails.set(user.id, email);

    if (!outcome.ok) {
      throw this.toEmailSetRejection(outcome);
    }

    /**
     * Counted here, which is `register`'s ordering rule read as far as this endpoint allows: a
     * request that mails nothing must not spend the address's allowance, or anyone could lock a
     * real mailbox out of ever receiving a code by asking about it four times.
     *
     * `emails.set` decides its refusals *before* it writes, so by this line every refusal has
     * happened and a code exists that is about to be delivered - which is the moment a send
     * becomes real and therefore the moment it may be charged for. The cost of sitting this late
     * is that a request the limit refuses has already had its address attached; that is the same
     * state a failed `sendOtp` leaves, and it is harmless because an unproved address is not a
     * delivery target (see `EmailService.set`), so no receipt can reach a mailbox through it.
     */
    await this.assertWithinEmailSendLimit(outcome.email);

    await this.sendEmailVerification(outcome.email, outcome.code);

    return {
      email: outcome.email,
      expiresAt: outcome.expiresAt.toISOString(),
      codeLength: this.config.getOrThrow<number>('otp.codeLength'),
    };
  }

  /**
   * Confirms the attached address with a code (Step 34c).
   *
   * A wrong, expired or exhausted code is answered with the same 400/429 the OTP endpoints use,
   * because it *is* the same code: the email verification code is an OTP with a different
   * destination, and its failure modes are the OTP's. Only the two account-shaped refusals -
   * "nothing is attached" and "already confirmed" - get their own answers.
   */
  async verifyEmail(user: SessionUser, dto: VerifyEmailDto): Promise<EmailVerifyResponseDto> {
    const outcome = await this.emails.verify(user.id, dto.code);

    if (!outcome.ok) {
      throw this.toEmailVerifyRejection(outcome);
    }

    return { email: outcome.email, emailVerifiedAt: outcome.emailVerifiedAt.toISOString() };
  }

  private normalizeEmail(input: string): string {
    try {
      return normalizeEmailAddress(input);
    } catch (error) {
      if (error instanceof InvalidEmailAddressError) {
        throw new BadRequestException(
          error.problem === 'too_long'
            ? `An email address can be at most ${MAX_EMAIL_LENGTH} characters.`
            : `"${error.input}" is not a valid email address.`,
        );
      }

      throw error;
    }
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
   * Turns a refused password change into the answer the caller can act on.
   *
   * Both refusals are a 409: the caller is authenticated, and a 409 says "this conflicts with
   * the state of the account" - which is exactly what a missing or wrong `currentPassword` is,
   * and it keeps the message in front of the user rather than in a 401 that would say "you are
   * not who you say you are" about a request whose identity was never in question.
   */
  private toPasswordRejection(outcome: PasswordChangeRefusal): HttpException {
    switch (outcome.reason) {
      case 'current_password_required':
        return new ConflictException(
          'This account already has a password. Send currentPassword to change it.',
        );

      case 'invalid_password':
        return new ConflictException('That current password is not correct.');
    }
  }

  /** Turns a refused email attach into the answer the caller can act on. */
  private toEmailSetRejection(outcome: EmailSetRefusal): HttpException {
    switch (outcome.reason) {
      case 'address_taken':
        return new ConflictException(
          'That email address is already in use on another account. Use a different address.',
        );
    }
  }

  /**
   * Turns a refused email confirmation into the answer the caller can act on.
   *
   * The two account-shaped reasons get their own answers; everything else is the OTP check's
   * outcome, mapped by the same table the phone endpoints use so the two cannot differ.
   */
  private toEmailVerifyRejection(outcome: EmailVerifyRefusal): HttpException {
    switch (outcome.reason) {
      case 'no_address':
        return new ConflictException(
          'No email address is attached to this account. Attach one with POST /auth/email.',
        );

      case 'already_verified':
        return new ConflictException('That email address is already verified.');

      case 'code':
        return this.toHttpException(outcome.failure);
    }
  }

  /**
   * Counts one verification email against the address's allowance, or refuses (Step 34c).
   *
   * The counter is `OtpRateLimiterService`'s deliberately, and the shape is `register`'s: one
   * subject, three sends per window (`OTP_REQUESTS_PER_WINDOW` / `OTP_REQUEST_WINDOW_MINUTES`). The
   * resource being spent is the same one the SMS endpoints spend - a message to a third party that
   * costs money on every call - so a limiter of its own would be a second place deciding how many
   * messages an identifier may cause, and the two could disagree (Step 34b's reason, unchanged).
   * This is the endpoint that made the gap obvious: it was the one send in this service that
   * consulted no counter at all.
   *
   * The subject is *the address*, which is the honest analogue of `register` counting the number the
   * text goes to: what a caller can pump is a mailbox, so the cap sits on the mailbox. Counting the
   * account instead would cap how much one account sends while leaving "many accounts, one inbox"
   * unaddressed, and it would spend a legitimate user's allowance on addresses they never attached -
   * a first typo, then a second, and the third attempt at the address they *do* own is refused.
   * Passing the mask with the subject keeps the limiter's own log line honest, and the mask is the
   * mail one because the identifier here is an address rather than a number.
   */
  private async assertWithinEmailSendLimit(email: string): Promise<void> {
    try {
      await this.otpRateLimiter.consume(email, maskEmailAddress(email));
    } catch (error) {
      if (error instanceof OtpRateLimitExceededError) {
        const minutes = Math.ceil(error.retryAfterSeconds / 60);

        throw new HttpException(
          `Too many verification emails requested for this address. Try again in ${minutes} minute${
            minutes === 1 ? '' : 's'
          }.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof OtpRateLimitUnavailableError) {
        // 5xx by design, and the same answer the OTP paths give: the limit could not be evaluated, so
        // nothing was sent. The safe failure for a cap whose purpose is to price messages is to send
        // none, and the client can act on it exactly as it acts on a failed send.
        throw new ServiceUnavailableException(
          'Verification is temporarily unavailable. Please try again in a moment.',
        );
      }

      throw error;
    }
  }

  /**
   * Sends the email verification code, translating a delivery failure into "nothing was sent".
   *
   * The mirror of `sendOtp`, and for the same reason: a provider that did not accept the
   * message means the user has no code, so the answer is a 503 rather than a success. The
   * address is deliberately not logged - a log line is one place an identifier must not appear
   * in the clear, and the `auth.email.set` entry already names the account.
   */
  private async sendEmailVerification(email: string, code: string): Promise<void> {
    try {
      await this.notifications.sendEmailVerification(email, code);
    } catch (error) {
      this.logger.error(
        'Could not send an email verification code',
        error instanceof Error ? error.stack : String(error),
      );

      throw new ServiceUnavailableException(
        'We could not send the verification email right now. Please try again.',
      );
    }
  }

  /**
   * Reads the one identifier a password sign-in carries, or refuses an ambiguous body (Step 34c).
   *
   * `phoneNumber` and `email` are one decision with two spellings, so exactly one is read. A body
   * with both is refused because *which* account it means would be ambiguous, and the rule this
   * endpoint would have to invent - number wins? - is one no caller could predict; a body with
   * neither is refused because there would be nothing to look up. Both messages name the fields,
   * which is why the rule lives here rather than in a decorator: the validation pipe can only say
   * "this field is wrong", and the answer here is about the pair.
   *
   * The value is normalized as it is read, so what is looked up is what the column holds:
   * `Miriam@Example.com` finds the row `POST /auth/email` stored as `miriam@example.com`, and
   * `024 123 4567` finds the row registration stored as `+233241234567`. A `PENDING` or otherwise
   * unusable value throws the same `BadRequestException` it throws everywhere else, which is the
   * point of routing through `normalizeEmail` and `normalize` rather than testing for an `@`.
   *
   * `masked` comes along because the identifier is about to be logged and counted, and *which*
   * mask is honest is a fact about the field rather than about the caller.
   */
  private signInIdentifier(dto: LoginPasswordDto): SignInIdentifier {
    if (dto.phoneNumber !== undefined && dto.email !== undefined) {
      throw new BadRequestException('Send either phoneNumber or email, not both.');
    }

    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);

      return { field: 'email', value: email, masked: maskEmailAddress(email) };
    }

    if (dto.phoneNumber === undefined) {
      throw new BadRequestException(
        'Send the phone number or the email address you sign in with, and the password.',
      );
    }

    const phoneNumber = this.normalize(dto.phoneNumber);

    return { field: 'phoneNumber', value: phoneNumber, masked: maskPhoneNumber(phoneNumber) };
  }

  /**
   * The row a password sign-in is about, or `null` for an identifier nothing holds.
   *
   * One query against the column the identifier names, rather than one `OR` across both: each
   * column is unique on its own and exactly one of them is present, so either way this is a single
   * indexed read. The address is looked up by the normalized value, which is the value
   * `EmailService` stored - the read the unique index on `users.email` exists for.
   *
   * `null` rather than an exception, because the several ways there is no signable account -
   * nothing holds the identifier, the row is not `ACTIVE`, the address was never proved - are one
   * answer by design, and only `loginWithPassword` knows what to say about them.
   */
  private findPasswordSignInUser(identifier: SignInIdentifier): Promise<UserModel | null> {
    return identifier.field === 'phoneNumber'
      ? this.prisma.user.findUnique({ where: { phoneNumber: identifier.value } })
      : this.prisma.user.findUnique({ where: { email: identifier.value } });
  }

  /**
   * Counts one password sign-in against the identifier's allowance, or refuses (Steps 34b, 34c).
   *
   * The counter is `OtpRateLimiterService`'s, deliberately: a password guess is then priced
   * exactly like a code guess, and there is one place - not two that could disagree - deciding
   * how many tries an identifier gets in a window. The subject is the identifier that was
   * submitted, normalized, so an address and a number on the same account have an allowance each
   * (as `register` counts them) rather than sharing one; the masked form travels with it because
   * the limiter logs what it is counting. What this adds is the wording: a caller who has been
   * signing in, rather than requesting codes, is told about sign-in attempts.
   */
  private async assertWithinPasswordAttemptLimit(identifier: SignInIdentifier): Promise<void> {
    try {
      await this.otpRateLimiter.consume(identifier.value, identifier.masked);
    } catch (error) {
      if (error instanceof OtpRateLimitExceededError) {
        const minutes = Math.ceil(error.retryAfterSeconds / 60);

        throw new HttpException(
          `Too many sign-in attempts for this account. Try again in ${minutes} minute${
            minutes === 1 ? '' : 's'
          }.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof OtpRateLimitUnavailableError) {
        throw new ServiceUnavailableException(
          'Sign-in is temporarily unavailable. Please try again in a moment.',
        );
      }

      throw error;
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
