import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { PIN_LENGTH } from '../../config/configuration.js';
import { PIN_PATTERN, pinRuleMessage } from './pin-pattern.js';

/**
 * Body of `POST /v1/auth/pin/verify` (Step 34a): the step-up call.
 *
 * The PIN is the one field, and it is never echoed back - not in the response, not in the
 * message of a refusal - so a client that logs its own request bodies is not the account's
 * only problem.
 *
 * The shape rule is enforced here, before anything is hashed or counted: `123` and `12a4`
 * are 400s from the validation pipe and never reach the attempt counter, which is what
 * keeps "someone is guessing my PIN" and "someone sent a malformed body" from becoming
 * the same row in the audit log.
 */
export class VerifyPinDto {
  @ApiProperty({
    description: `The ${PIN_LENGTH}-digit PIN. Exactly ${PIN_LENGTH} numeric digits.`,
    example: '1234',
    minLength: PIN_LENGTH,
    maxLength: PIN_LENGTH,
    pattern: PIN_PATTERN.source,
  })
  @IsString()
  @Matches(PIN_PATTERN, { message: pinRuleMessage('pin') })
  pin!: string;
}
