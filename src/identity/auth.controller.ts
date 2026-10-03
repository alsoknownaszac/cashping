import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/http/swagger.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ChangePinDto } from './dto/change-pin.dto.js';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto.js';
import { EmailSetResponseDto } from './dto/email-set-response.dto.js';
import { EmailVerifyResponseDto } from './dto/email-verify-response.dto.js';
import { LoginCodeResponseDto } from './dto/login-code-response.dto.js';
import { LoginDto, LoginResponseDto } from './dto/login.dto.js';
import { LoginPasswordDto } from './dto/login-password.dto.js';
import { SubmittedPhoneNumberDto } from './dto/phone-number.dto.js';
import { PasswordSetResponseDto } from './dto/password-set-response.dto.js';
import { PinChangeResponseDto } from './dto/pin-change-response.dto.js';
import { PinVerifyResponseDto } from './dto/pin-verify-response.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterResponseDto } from './dto/register-response.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionResponseDto } from './dto/session-response.dto.js';
import { SetEmailDto } from './dto/set-email.dto.js';
import { TokenPairResponseDto } from './dto/token-pair-response.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { VerifyOtpResponseDto } from './dto/verify-otp-response.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { VerifyPinDto } from './dto/verify-pin.dto.js';
import { CurrentUser } from './jwt/current-user.decorator.js';
import { JwtAuthGuard } from './jwt/jwt-auth.guard.js';
import { type SessionUser } from './token/token.service.js';

/**
 * Everything a client does to become, and stay, signed in (Steps 10, 14 and 16):
 * register, verify, sign in, refresh, log out, and read the signed-in user. Mounted
 * under the global prefix, so the paths the frontend calls are `/v1/auth/register`,
 * `/v1/auth/otp/verify`, `/v1/auth/login/otp`, `/v1/auth/login`, `/v1/auth/refresh`,
 * `/v1/auth/logout` and `/v1/auth/session`.
 *
 * Step 34a adds the transaction PIN's two endpoints - `/v1/auth/pin/change` (set or change)
 * and `/v1/auth/pin/verify` (prove it) - and they are the same shape as the rest of this
 * file: a DTO that establishes the body is well-formed, a delegation to `AuthService`, and
 * `JwtAuthGuard` on anything that needs the caller to be signed in.
 *
 * The one thing that is *not* like the others is what `pin/verify` answers: not a session,
 * but a short-lived step-up token. It is a credential the client presents on
 * `POST /v1/payments` in an `X-Step-Up-Token` header, and it is deliberately useless
 * anywhere else - it expires in minutes, it cannot be refreshed, and it authorises nothing
 * but proving the PIN again.
 *
 * Every handler is one delegation: the DTOs establish that a request is well-formed
 * and `AuthService` owns the logic and the status codes, which is why nothing here
 * knows what an OTP row or a refresh-token row looks like.
 *
 * `GET /session` is the only route here that carries `JwtAuthGuard`, and it is the
 * template for the ones that will follow it: the guard in front of the handler,
 * `@ApiBearerAuth()` so the document shows the padlock and says a token is required,
 * and `@CurrentUser()` for the user. The guard is per-route rather than global on
 * purpose; `JwtAuthGuard` explains why. `POST /logout` deliberately has neither: it is
 * authenticated by the refresh token in its body, which is the credential being thrown
 * away - asking for the access token as well would only make a client that has already
 * lost the access token unable to end the session it still holds.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Start registration and text a verification code',
    description: [
      'Creates the account (or restarts one that is still awaiting verification) and sends a code by SMS.',
      '',
      'The number is accepted in any reasonable format - `024 123 4567`, `+233241234567`, `+2330241234567`, `00233241234567` - and stored as E.164.',
      '',
      '`pin` is required, and it is the account\'s transaction PIN: exactly four numeric digits, stored hashed, never returned by any endpoint. Every payment is refused until it is proved again at `POST /auth/pin/verify`, so it is collected here rather than behind a screen the user can skip. A PIN that is not four numeric digits is a 400, and no account is created.',
      '',
      'The response never contains the code: the SMS is its only route to the user. Calling this again for an unverified number is the resend path and invalidates the previous code.',
    ].join('\n'),
  })
  @ApiCreatedResponse({
    type: RegisterResponseDto,
    description: 'Account created (or already pending) and a code sent by SMS.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body is missing `phoneNumber` or `pin`, the number is not a valid phone number, or the PIN is not exactly four numeric digits.',
    },
    {
      status: 403,
      description: 'The number belongs to a suspended account. No code is sent.',
    },
    {
      status: 409,
      description:
        'The number is already registered and verified. Sign in, or register a different number.',
    },
    {
      status: 429,
      description:
        'Too many codes have been requested for this number in the current window. The message says how long to wait.',
    },
    {
      status: 503,
      description:
        'No code could be sent (SMS provider or the request counter is unreachable). Nothing was sent; retry shortly.',
    },
    {
      status: 500,
      description: 'Unexpected failure, in the shared error shape.',
    },
  ])
  register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    // 201 is `@Post`'s default and is left implicit here; the explicit `@HttpCode`
    // belongs on verify, whose success is not the creation of anything.
    return this.authService.register(dto);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the code and activate the account',
    description: [
      'Checks the code sent to the number, then marks the account `ACTIVE` and stamps `phoneVerifiedAt` - the hand-off point to account provisioning.',
      '',
      'The number must be submitted again in the same free format as registration; it is normalized before lookup, so the two do not have to be spelled identically. The code is single-use, expires, and allows a limited number of wrong guesses.',
      '',
      'A code is checked here, not created: a 400 means "ask for a new code", not "try this one again".',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: VerifyOtpResponseDto,
    description: 'The number is verified and the account is active.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body failed validation, or the code is wrong, expired, or no code is outstanding. The message distinguishes the cases.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 404,
      description: 'No account was ever registered for that number.',
    },
    {
      status: 409,
      description: 'The number is already verified, or that code has already been used.',
    },
    {
      status: 429,
      description: 'The code has no attempts left. It cannot be retried - request a new one.',
    },
    {
      status: 503,
      description: 'Verification is temporarily unavailable (a dependency could not be reached).',
    },
    {
      status: 500,
      description: 'Unexpected failure, in the shared error shape.',
    },
  ])
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<VerifyOtpResponseDto> {
    // 200 rather than 201: verification spends a code and changes a status, it
    // does not create a resource. 201 here would tell a client to look for a
    // `Location` that does not exist.
    return this.authService.verifyOtp(dto);
  }

  @Post('login/otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Text a sign-in code to a number that already has an account',
    description: [
      'The first half of signing in: sends a code to a registered, verified number, so the client can then call `POST /auth/login`.',
      '',
      'Registration cannot be reused for this. It answers 409 for a number that is already verified, and the code it sent has already been spent by verification - so a user coming back on a new device needs a code of their own, which is what this endpoint is.',
      '',
      "A number with no account is a 404 rather than a silent 200. The copy in the docs is the same as the code's: the silent version leaves someone who mistyped their number waiting for an SMS that is never coming, and it hides nothing, because registration already answers differently for a verified number (409) than for a free one.",
      '',
      'Calling it again is the resend path and invalidates the previous code, exactly as in registration. The response never contains the code: the SMS is its only route to the user.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: LoginCodeResponseDto,
    description: 'A sign-in code was sent by SMS to the registered number.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: 'The body is missing `phoneNumber`, or the number is not a valid phone number.',
    },
    {
      status: 404,
      description:
        'No account is registered for that number. The call to action is registration, not a retry.',
    },
    {
      status: 403,
      description: 'The account is suspended. No code is sent.',
    },
    {
      status: 409,
      description: 'The account exists but has not been verified yet. Finish registering first.',
    },
    {
      status: 429,
      description:
        'Too many codes have been requested for this number in the current window. The message says how long to wait.',
    },
    {
      status: 503,
      description:
        'No code could be sent (SMS provider or the request counter is unreachable). Nothing was sent; retry shortly.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  requestLoginCode(@Body() dto: SubmittedPhoneNumberDto): Promise<LoginCodeResponseDto> {
    // 200, not `@Post`'s default 201: nothing the client can address was created.
    // The code row is new, but it is not a resource this API ever returns - what
    // comes back is the fact that an SMS is on its way.
    return this.authService.requestLoginCode(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with a code and start a session',
    description: [
      'Spends the code from `POST /auth/login/otp` and returns a token pair plus the signed-in profile.',
      '',
      'Nothing about the account changes here: the code is spent and no user column is written. `phoneVerifiedAt` is not re-stamped, because it records when the *number* was proven.',
      '',
      'Both tokens are returned together, and both are needed. The access token is a JWT with a 15-minute lifetime that this API does not store - it cannot be withdrawn, so it stays short-lived. The refresh token is the long-lived half, stored (hashed) and single-use: `POST /auth/refresh` returns a new pair and retires the one it was given.',
      '',
      'A code is checked here, not created: a 400 means "ask for a new code", not "try this one again".',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: LoginResponseDto,
    description: 'The code was correct and a session has started.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body failed validation, or the code is wrong, expired, or no code is outstanding. The message distinguishes the cases.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 404,
      description: 'No account is registered for that number.',
    },
    {
      status: 409,
      description: 'The number has not been verified yet, or that code has already been used.',
    },
    {
      status: 429,
      description: 'The code has no attempts left. It cannot be retried - request a new one.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description: [
      "What keeps a session alive past the access token's 15 minutes, and the reason a client never has to send the user back to the code screen.",
      '',
      'The refresh token is rotated on every use: the one presented is retired and a new one comes back. That is what makes a stolen token detectable - if a retired token is presented again, the whole family is treated as exposed, every session for that user is revoked, and the client is told to sign in again.',
      '',
      'Two consequences for the client, and both are obligations rather than advice: store the returned `refreshToken`, replacing the old one (which now fails), and never call this twice in parallel with the same token - the second call loses the race and looks exactly like a replay.',
      '',
      'Every failure is one 401 with one message. Expired, already rotated, never existed and malformed are indistinguishable on purpose: the caller is anonymous here, and a message that told them apart would be an oracle worth reading.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: TokenPairResponseDto,
    description: 'A new token pair. The refresh token that was sent is no longer usable.',
  })
  @ApiErrorResponses([
    { status: 400, description: 'The body is missing `refreshToken`.' },
    {
      status: 401,
      description:
        'The refresh token is not usable: expired, already rotated, unknown, or malformed. Sign in again.',
    },
    {
      status: 403,
      description: 'The account is suspended, so it cannot be renewed into a session.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPairResponseDto> {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End the session a refresh token belongs to',
    description: [
      'Revokes one session. Other sessions - another phone, a tablet - are untouched: every sign-in has its own refresh token, and each is revoked on its own.',
      '',
      'This is not a bearer-token endpoint, and it does not shorten the life of any access token. What it ends is the ability to renew a session, which is what makes "signed out" something the client cannot undo; the access token still in the client\'s hands is dropped by the client, and a copy of it stays valid for what is left of its 15 minutes. That is the price of not storing access tokens at all.',
      '',
      'Answers 204 either way, including for a refresh token this API does not recognise or has already retired. The caller asked for a session to end and it is ended (or never existed); a 401 for a credential that is on its way out would only produce a "sign-out failed" screen with nothing to do about it.',
    ].join('\n'),
  })
  @ApiNoContentResponse({ description: 'The session is revoked (or was already over).' })
  @ApiErrorResponses([
    { status: 400, description: 'The body is missing `refreshToken`.' },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    // `async` only to return a promise: there is no body, which is what 204 says.
    await this.authService.logout(dto);
  }

  @Get('session')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The signed-in user',
    description: [
      "The endpoint a client calls on launch with the access token it stored, and the only way to read the signed-in user's own profile.",
      '',
      "What comes back is the row as it is *now*. Nothing is trusted from the token's claims beyond the user id, so a handle changed on another device shows up here immediately, and an account suspended a second ago is refused with a 403 rather than accepted for the rest of the token's 15 minutes.",
      '',
      'A 401 means the access token was not accepted - most often it expired, which is the case `POST /auth/refresh` exists for. The message does not distinguish expired from malformed from unknown, so a client should refresh on `accessTokenExpiresAt` (less a margin) and treat any 401 as "refresh, and if that fails, sign in again".',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: SessionResponseDto,
    description: 'The access token is valid and the account is active.',
  })
  @ApiErrorResponses([
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  session(@CurrentUser() user: SessionUser): SessionResponseDto {
    // Synchronous, unlike every other handler here: `JwtStrategy` has already read
    // the row, so there is nothing left to await.
    return this.authService.session(user);
  }

  @Post('pin/change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Set or change your transaction PIN',
    description: [
      'Sets the PIN when the account has none, or changes it by proving the current one. The PIN is the second factor in front of money: `POST /v1/payments` is refused until it has been proved, so it is the one credential a stolen session does not hand over.',
      '',
      'Send `{ pin }` when there is no PIN yet (a Google-SSO account created in Step 34d). Send `{ currentPin, pin }` to change an existing one - a change is a 409 when `currentPin` is missing or wrong, and the response names how many attempts are left.',
      '',
      'The PIN is exactly four numeric digits. That is checked before anything is hashed, so a malformed one is a 400 that costs no attempt: only a correct-format PIN that does not match counts against the allowance.',
      '',
      'Five wrong `currentPin` values lock the PIN for fifteen minutes and answer 429. The counter and the lockout are the same ones `POST /auth/pin/verify` uses, deliberately: a change path with arithmetic of its own would be a quieter way to guess.',
      '',
      'The response contains no PIN, and no hash - it contains when the PIN now in force was written.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: PinChangeResponseDto,
    description: 'The PIN is set (or changed), and the old one no longer works.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body is missing `pin`, or `pin`/`currentPin` is not exactly four numeric digits.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 409,
      description:
        'The account already has a PIN and `currentPin` was omitted or is not correct. The message says how many attempts are left.',
    },
    {
      status: 429,
      description:
        'Too many incorrect PIN attempts, so the PIN is locked. The message says when it can be tried again.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  changePin(
    @CurrentUser() user: SessionUser,
    @Body() dto: ChangePinDto,
  ): Promise<PinChangeResponseDto> {
    return this.authService.changePin(user, dto);
  }

  @Post('pin/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Prove your transaction PIN and get a step-up token',
    description: [
      'The step-up call. A correct PIN answers with a short-lived token that `POST /v1/payments` requires in an `X-Step-Up-Token` header - the second factor, as a value the client can present rather than a second session.',
      "The token lives for five minutes and carries one claim: that this account proved its PIN. It cannot be renewed, and it authorises nothing except being a fresh PIN proof - the way to get another is to prove the PIN again.",
      '',
      'A wrong PIN is a 401 whose message says how many attempts are left. Five wrong attempts lock the PIN for fifteen minutes and answer 429.',
      '',
      'The PIN itself never appears in the response, in an error message, or in the audit log. Neither does the attempt counter on a successful call: a proof that succeeded has none left to report.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: PinVerifyResponseDto,
    description: 'The PIN was correct; the step-up token is valid for a few minutes.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: 'The body is missing `pin`, or it is not exactly four numeric digits.',
    },
    {
      status: 401,
      description:
        'Either there is no usable access token (no `Authorization` header, or it is expired, malformed, or not one this API signed), or the PIN is not correct. Both are "this credential was not accepted".',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 409,
      description: 'The account has no PIN set, so there is nothing to prove yet.',
    },
    {
      status: 429,
      description:
        'Too many incorrect PIN attempts, so the PIN is locked. The message says when it can be tried again.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  verifyPin(
    @CurrentUser() user: SessionUser,
    @Body() dto: VerifyPinDto,
  ): Promise<PinVerifyResponseDto> {
    return this.authService.verifyPin(user, dto);
  }

  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Set or change your password',
    description: [
      'Sets the password when the account has none, or changes it by proving the current one. The password is the *recovery* credential - what gets a user back into their account - rather than the second factor in front of money, which is the transaction PIN.',
      '',
      'Send `{ password }` when there is no password yet. Send `{ currentPassword, password }` to change an existing one - a change is a 409 when `currentPassword` is missing or wrong.',
      '',
      'The password must be at least `PASSWORD_MIN_LENGTH` characters. That is checked before anything is hashed, so a too-short one is a 400 that reaches no hasher.',
      '',
      'The response contains no password and no hash - it contains when the password now in force was written.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: PasswordSetResponseDto,
    description: 'The password is set (or changed), and the old one no longer works.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: 'The body is missing `password`, or `password` is shorter than the minimum.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 409,
      description:
        'The account already has a password and `currentPassword` was omitted or is not correct.',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  changePassword(
    @CurrentUser() user: SessionUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<PasswordSetResponseDto> {
    return this.authService.changePassword(user, dto);
  }

  @Post('login/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with a password',
    description: [
      'The password sign-in, the counterpart to `POST /auth/login` (which uses a texted code). A correct password answers the same token pair and profile the code sign-in answers.',
      '',
      'Identify the account with either identifier it has: `phoneNumber` in any reasonable format, or `email` - the address `POST /auth/email/verify` proved. Send exactly one of the two; sending both, or neither, is a 400 that names the fields. An address that was attached but never verified is answered exactly as an address nothing holds, because this endpoint is not allowed to become a way of finding out which addresses are registered.',
      '',
      'A wrong password is a 401 whose message is *identical* to the one for an identifier with no account, no password set, or an unverified address: none of them are distinguishable from outside, so this endpoint is not an oracle that tells an attacker which numbers and addresses are registered.',
      '',
      'Sign-in attempts are counted against the same per-identifier allowance as OTP sends, so a password guess is priced exactly like a code guess; over the allowance is a 429.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: LoginResponseDto,
    description: 'The password was accepted and a session started.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body is missing `password`, or sends both `phoneNumber` and `email`, or neither, or the identifier is not usable.',
    },
    {
      status: 401,
      description:
        'The identifier and password did not match, or the identifier has no account, no password set, or an address that was never verified. One message for all of them.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 429,
      description:
        'Too many sign-in attempts for this account. The message says how long to wait.',
    },
    {
      status: 503,
      description: 'Sign-in is temporarily unavailable (the attempt counter is unreachable).',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  loginWithPassword(@Body() dto: LoginPasswordDto): Promise<LoginResponseDto> {
    return this.authService.loginWithPassword(dto);
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a password reset',
    description: [
      'Begins a forgot-password reset by texting a code to the number, reusing the OTP machinery (a reset code is an OTP with a different purpose, not a second code system).',
      '',
      'Answers **202 whether or not the number belongs to an account**, and the body is the same either way - this endpoint must not be an existence oracle. A code is sent, and an audit row written, only when the number really resolves to an `ACTIVE` account.',
    ].join('\n'),
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: LoginCodeResponseDto,
    description:
      'A code was sent if the number belongs to an account. The response is identical either way.',
  })
  @ApiErrorResponses([
    { status: 400, description: 'The number is not a valid phone number.' },
    {
      status: 429,
      description:
        'Too many codes have been requested for this number in the current window. The message says how long to wait.',
    },
    {
      status: 503,
      description: 'No code could be sent (SMS provider or the request counter is unreachable).',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  requestPasswordReset(@Body() dto: SubmittedPhoneNumberDto): Promise<LoginCodeResponseDto> {
    return this.authService.requestPasswordReset(dto);
  }

  @Post('password/reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish a password reset',
    description: [
      'Checks the reset code and writes the new password. The code is checked and spent exactly as it is at verification and sign-in - the same lifetime, attempt count and single-use rules - so a wrong or expired code is a 400 and an exhausted one is a 429.',
      '',
      'The code is spent before the new password is written, so a double-tapped confirm cannot write twice.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: PasswordSetResponseDto,
    description: 'The code was accepted and the password is replaced.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body failed validation, or the code is wrong, expired, or no reset is outstanding.',
    },
    { status: 403, description: 'The account is suspended.' },
    { status: 409, description: 'That code has already been used.' },
    { status: 429, description: 'Too many incorrect code attempts. Request a new one.' },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto): Promise<PasswordSetResponseDto> {
    return this.authService.confirmPasswordReset(dto);
  }

  @Post('email')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Attach an email address and send a verification code',
    description: [
      'Attaches (or replaces) the account email address and emails a verification code to it. The address is stored lower-cased, so one mailbox is one value.',
      '',
      'The address is written *unverified*: a receipt is only ever sent to an address that has been confirmed, which is what `POST /auth/email/verify` does. Replacing the address clears any earlier confirmation, so a typo cannot leave mail going somewhere unproved.',
      '',
      'A 409 means another account already holds that address. The code itself never appears in the response - the email is its only route to the user.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: EmailSetResponseDto,
    description: 'The address is attached and a verification code has been emailed.',
  })
  @ApiErrorResponses([
    { status: 400, description: 'The body is missing `email`, or the address is not a valid one.' },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 409,
      description: 'That email address is already in use on another account.',
    },
    {
      status: 503,
      description: 'The verification email could not be sent (no provider, or it was unreachable).',
    },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  setEmail(@CurrentUser() user: SessionUser, @Body() dto: SetEmailDto): Promise<EmailSetResponseDto> {
    return this.authService.setEmail(user, dto);
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Confirm your email address',
    description: [
      'Confirms the address attached to the account with the code that was emailed to it. The address is already on the account, so only the code is sent.',
      'The code is an OTP with the same lifetime and attempt count as every other code, so a wrong or expired one is a 400 and an exhausted one is a 429.',
      '',
      'A 409 means nothing is attached yet, or the attached address is already confirmed.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: EmailVerifyResponseDto,
    description: 'The address is confirmed, and receipts may now be sent to it.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: 'The body is missing `code`, or the code is wrong, expired or not outstanding.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 409,
      description: 'No email address is attached, or the attached one is already verified.',
    },
    { status: 429, description: 'Too many incorrect code attempts. Attach the address again.' },
    { status: 500, description: 'Unexpected failure, in the shared error shape.' },
  ])
  verifyEmail(
    @CurrentUser() user: SessionUser,
    @Body() dto: VerifyEmailDto,
  ): Promise<EmailVerifyResponseDto> {
    return this.authService.verifyEmail(user, dto);
  }
}
