import { PIN_LENGTH } from '../../config/configuration.js';

/**
 * The one statement of the PIN's shape (Step 34a), imported by every DTO that accepts
 * one: `RegisterDto`, `ChangePinDto` and `VerifyPinDto`.
 *
 * Built from `PIN_LENGTH` rather than written as `^\d{4}$`, exactly as
 * `verify-otp.dto.ts` builds its code pattern from `OTP_CODE_LENGTH`. If the policy ever
 * changes, the rule changes with it, and nothing is left behind rejecting valid input.
 *
 * It lives here rather than in each DTO because there are three of them, and a
 * per-endpoint copy of a rule is how "exactly four digits" and "exactly four digits,
 * unless you are setting one" both end up in the same API.
 */
export const PIN_PATTERN = new RegExp(`^\\d{${PIN_LENGTH}}$`);

/**
 * The message a rejected PIN carries, naming the field it arrived in and the rule it
 * broke.
 *
 * A function rather than a constant because one rule is applied to two fields - `pin`,
 * and `currentPin` on a change - and a message that says "pin must be ..." to a caller
 * whose `currentPin` was malformed sends them to the wrong part of the form.
 */
export function pinRuleMessage(field: 'pin' | 'currentPin'): string {
  return `${field} must be exactly ${PIN_LENGTH} digits`;
}
