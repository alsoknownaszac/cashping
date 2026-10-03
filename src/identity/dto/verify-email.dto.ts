import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { OTP_CODE_LENGTH } from '../../config/configuration.js';
import { CODE_PATTERN, codeRuleMessage } from './otp-code-pattern.js';

/**
 * Body of `POST /v1/auth/email/verify` (Step 34c): confirm the attached address.
 *
 * Only the code is sent - the address is already on the account, so re-submitting it would
 * be a second source of truth for what is being verified. The shape rule is enforced here,
 * before any row is read, so a malformed code is a 400 that costs the code none of its
 * attempts: only a correct-format code that does not match counts.
 */
export class VerifyEmailDto {
  @ApiProperty({
    description: `The ${OTP_CODE_LENGTH}-digit code from the email.`,
    example: '123456',
    minLength: OTP_CODE_LENGTH,
    maxLength: OTP_CODE_LENGTH,
    pattern: CODE_PATTERN.source,
  })
  @IsString()
  @Matches(CODE_PATTERN, { message: codeRuleMessage('email') })
  code!: string;
}
