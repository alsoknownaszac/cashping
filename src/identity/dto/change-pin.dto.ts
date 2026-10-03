import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { PIN_LENGTH } from '../../config/configuration.js';
import { PIN_PATTERN, pinRuleMessage } from './pin-pattern.js';

/**
 * Body of `POST /v1/auth/pin/change` (Step 34a): set a PIN when the account has none,
 * change it when it has one.
 *
 * One class for both halves of that contract, because they are one decision from the
 * client's side - "here is the PIN I want" - and the difference is a fact about the
 * account rather than about the request. `pin` is therefore required and `currentPin` is
 * optional, and the *presence* rule ("required when a PIN is already set") is enforced in
 * `PinService`, which can read the row; a DTO cannot know it.
 *
 * What this class does enforce is the shape of both fields, and that matters more than it
 * looks: a `currentPin` that is not four digits is refused with a 400 by the validation
 * pipe before any row is read, so it never counts as a wrong guess against the lockout.
 * Only a **correct-format** PIN that does not match is an attempt (`auth.pin.failed`).
 */
export class ChangePinDto {
  @ApiProperty({
    description: `The ${PIN_LENGTH}-digit PIN to set. Exactly ${PIN_LENGTH} numeric digits.`,
    example: '1234',
    minLength: PIN_LENGTH,
    maxLength: PIN_LENGTH,
    pattern: PIN_PATTERN.source,
  })
  @IsString()
  @Matches(PIN_PATTERN, { message: pinRuleMessage('pin') })
  pin!: string;

  @ApiPropertyOptional({
    description: `The PIN currently set, required when the account already has one. Exactly ${PIN_LENGTH} numeric digits. Omit it when setting a PIN for the first time.`,
    example: '1234',
    minLength: PIN_LENGTH,
    maxLength: PIN_LENGTH,
    pattern: PIN_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(PIN_PATTERN, { message: pinRuleMessage('currentPin') })
  currentPin?: string;
}
