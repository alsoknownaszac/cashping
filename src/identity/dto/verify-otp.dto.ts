import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { OTP_CODE_LENGTH } from '../../config/configuration.js';

/**
 * The code is exactly `OTP_CODE_LENGTH` digits, and the pattern is built from
 * that constant rather than written as `\d{6}`: if the policy in
 * `configuration.ts` ever changes, this rule changes with it instead of rejecting
 * the codes the service just issued.
 */
const CODE_PATTERN = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`);

/**
 * Body of `POST /v1/auth/otp/verify` (Step 14).
 *
 * The phone number is submitted again, in the same free format as registration:
 * the code alone would be ambiguous, and re-deriving the number from a code would
 * mean looking a user up by something that is not unique to them. Normalization
 * runs on this side too, so `024 123 4567` here finds the row created by
 * `+233241234567` there - which is the whole reason Step 9 exists.
 */
export class VerifyOtpDto {
  @ApiProperty({
    description:
      'The number that was registered, in any reasonable format. Normalized before lookup, so it does not have to match the format submitted to /auth/register.',
    example: '024 123 4567',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phoneNumber!: string;

  @ApiProperty({
    description: `The ${OTP_CODE_LENGTH}-digit code from the SMS.`,
    example: '123456',
    minLength: OTP_CODE_LENGTH,
    maxLength: OTP_CODE_LENGTH,
    pattern: CODE_PATTERN.source,
  })
  @IsString()
  // Only the shape is checked here. Whether the code is *right*, still valid, or
  // has attempts left are three different answers with three different responses,
  // and all of them belong to the service that can see the row.
  @Matches(CODE_PATTERN, { message: `code must be the ${OTP_CODE_LENGTH} digits from the SMS` })
  code!: string;
}
