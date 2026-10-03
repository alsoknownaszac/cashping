import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  OTP_CODE_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../config/configuration.js';
import { CODE_PATTERN, codeRuleMessage } from './otp-code-pattern.js';
import { SubmittedPhoneNumberDto } from './phone-number.dto.js';

/**
 * Body of `POST /v1/auth/password/reset/confirm` (Step 34b).
 *
 * Three fields, and each is here for a reason. The number, because the code alone is
 * ambiguous and re-deriving the account from a code would mean looking a user up by
 * something that is not unique to them - the same argument `VerifyOtpDto` makes. The code,
 * because it is the proof of possession the reset rests on. And the new password, whose
 * length floor is enforced at this door precisely as it is on the change endpoint, from the
 * same `PASSWORD_MIN_LENGTH`, so a code cannot be spent on a password the service would
 * have refused anyway.
 */
export class ConfirmPasswordResetDto extends SubmittedPhoneNumberDto {
  @ApiProperty({
    description: `The ${OTP_CODE_LENGTH}-digit reset code from the SMS.`,
    example: '123456',
    minLength: OTP_CODE_LENGTH,
    maxLength: OTP_CODE_LENGTH,
    pattern: CODE_PATTERN.source,
  })
  @IsString()
  @Matches(CODE_PATTERN, { message: codeRuleMessage('SMS') })
  code!: string;

  @ApiProperty({
    description: `The new password. At least ${PASSWORD_MIN_LENGTH} characters.`,
    example: 'correct horse battery staple',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `newPassword must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `newPassword must be at most ${PASSWORD_MAX_LENGTH} characters`,
  })
  newPassword!: string;
}
