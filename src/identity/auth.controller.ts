import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/http/swagger.js';
import { AuthService } from './auth.service.js';
import { RegisterResponseDto } from './dto/register-response.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { VerifyOtpResponseDto } from './dto/verify-otp-response.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';

/**
 * The two endpoints that take a stranger's phone number and turn it into a proven
 * identity (Steps 10 and 14). Mounted under the global prefix, so the paths the
 * frontend calls are `/v1/auth/register` and `/v1/auth/otp/verify`.
 *
 * Both are thin on purpose: the DTOs establish that a request is well-formed and
 * `AuthService` owns the logic and the status codes. Nothing here knows what an
 * OTP row looks like.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Start registration and text a verification code',
    description:
      [
        'Creates the account (or restarts one that is still awaiting verification) and sends a code by SMS.',
        '',
        'The number is accepted in any reasonable format - `024 123 4567`, `+233241234567`, `+2330241234567`, `00233241234567` - and stored as E.164.',
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
        'The body is missing `phoneNumber`, or the number is not a valid phone number.',
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
      description:
        'The code has no attempts left. It cannot be retried - request a new one.',
    },
    {
      status: 503,
      description:
        'Verification is temporarily unavailable (a dependency could not be reached).',
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
}
