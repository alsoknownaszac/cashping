import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';
import { TokenPairResponseDto } from './token-pair-response.dto.js';
import { VerifyOtpDto } from './verify-otp.dto.js';

/**
 * Body of `POST /v1/auth/login` (Step 16).
 *
 * The body is exactly `VerifyOtpDto`'s - a phone number and a code - and it stays
 * exactly that on purpose rather than by copying the fields: the two endpoints ask
 * the client for the same two values, and a copy is a place for them to drift (one
 * endpoint tightening the code shape, the other not). Registering a subclass also
 * gives `POST /auth/login` its own name in the OpenAPI document, which is what the
 * frontend engineer searches for, while the validation rules stay in one place.
 *
 * What is *not* shared is what the code does. `verifyOtp` activates an account;
 * `login` does not touch the account at all, it spends the code and starts a session.
 */
export class LoginDto extends VerifyOtpDto {}

/**
 * 200 body of `POST /v1/auth/login`.
 *
 * The tokens come from `TokenPairResponseDto`; the four fields this class adds are the
 * same four `SessionResponseDto` returns, so a client that has just signed in and a
 * client restoring a session on the next launch parse the same profile without a
 * second mapping - and the user's handle is on screen immediately rather than after
 * one more round trip.
 *
 * `status` is `ACTIVE` in every successful login today (`login` refuses a suspended
 * account and a pending one), and it is still returned: it is the field the client
 * checks before deciding that the session is a usable one, and its being constant is
 * a fact about the current policy rather than about this contract.
 */
export class LoginResponseDto extends TokenPairResponseDto {
  @ApiProperty({
    description: 'The account that just signed in.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  userId!: string;

  @ApiProperty({
    description: 'The number that signed in, as stored: strict E.164.',
    example: '+233241234567',
  })
  phoneNumber!: string;

  @ApiProperty({
    description: '`ACTIVE` for any account that can sign in with a code.',
    enum: UserStatus,
    example: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  @ApiProperty({
    description: 'The claimed handle, or `null` if none was claimed at registration.',
    example: 'miriam_owusu',
    nullable: true,
    type: String,
  })
  handle!: string | null;
}
