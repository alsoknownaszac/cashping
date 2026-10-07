import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { OTP_CODE_LENGTH, PIN_LENGTH } from '../../config/configuration.js';
import { CODE_PATTERN, codeRuleMessage } from './otp-code-pattern.js';
import { SubmittedPhoneNumberDto } from './phone-number.dto.js';
import { PIN_PATTERN, pinRuleMessage } from './pin-pattern.js';

/**
 * Body of `POST /v1/auth/pin/reset/confirm`: finish a forgot-PIN reset.
 *
 * The same three fields `ConfirmPasswordResetDto` carries, for the same reasons: the number,
 * because the code alone is ambiguous and re-deriving the account from a code would mean
 * looking a user up by something that is not unique to them; the code, because it is the
 * proof of possessions the reset rests on; and the new PIN, whose shape is enforced at this
 * door from the same `pin-pattern.ts` the registration and change bodies use, so a code
 * cannot be spent on a PIN the service would have refused anyway.
 *
 * It is a separate class rather than a reuse of `ConfirmPasswordResetDto` because the
 * credential differs: a reset PIN is four digits, not a passphrase, and a body that accepted
 * both shapes at this route would let someone set a password where a PIN was expected. The
 * rule module is shared, the class is not.
 */
export class ConfirmPinResetDto extends SubmittedPhoneNumberDto {
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
    description: `The new PIN. Exactly ${PIN_LENGTH} numeric digits.`,
    example: '1234',
    minLength: PIN_LENGTH,
    maxLength: PIN_LENGTH,
    pattern: PIN_PATTERN.source,
  })
  @IsString()
  @Matches(PIN_PATTERN, { message: pinRuleMessage('pin') })
  pin!: string;
}
