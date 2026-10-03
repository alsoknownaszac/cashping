import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { OTP_CODE_LENGTH } from '../../config/configuration.js';
import { CODE_PATTERN, codeRuleMessage } from './otp-code-pattern.js';
import { SubmittedPhoneNumberDto } from './phone-number.dto.js';

/**
 * Body of `POST /v1/auth/otp/verify` (Step 14), and - through `LoginDto` - of
 * `POST /v1/auth/login` (Step 16).
 *
 * The phone number is submitted again, in the same free format as registration:
 * the code alone would be ambiguous, and re-deriving the number from a code would
 * mean looking a user up by something that is not unique to them. Normalization
 * runs on this side too, so `024 123 4567` here finds the row created by
 * `+233241234567` there - which is the whole reason Step 9 exists.
 *
 * The number itself comes from `SubmittedPhoneNumberDto`; this class adds the code.
 */
export class VerifyOtpDto extends SubmittedPhoneNumberDto {
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
  @Matches(CODE_PATTERN, { message: codeRuleMessage('SMS') })
  code!: string;
}
