import { OTP_CODE_LENGTH } from '../../config/configuration.js';

/**
 * The one statement of an OTP code's shape (Step 34b), imported by every DTO that accepts
 * one: the phone login body (`VerifyOtpDto`, and through it `LoginDto`), the password-reset
 * confirmation, and the email-verification call.
 *
 * Lifted out of `verify-otp.dto.ts` when a second and third endpoint arrived, for the reason
 * `pin-pattern.ts` exists: a per-endpoint copy of a rule is how "six digits" and "six digits,
 * unless you are resetting a password" both end up in the same API. The pattern is built from
 * `OTP_CODE_LENGTH` rather than written as `\d{6}`, so a change to the policy changes the
 * rule with it instead of leaving a stale literal rejecting the codes the service just sent.
 */
export const CODE_PATTERN = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`);

/**
 * The message a rejected code carries, naming where the digits came from.
 *
 * A parameter rather than a constant because one endpoint's code arrives by SMS and another
 * by email, and a message that says "from the SMS" in front of someone who is holding a
 * reset email sends them looking at the wrong device.
 */
export function codeRuleMessage(source: 'SMS' | 'email'): string {
  return `code must be the ${OTP_CODE_LENGTH} digits from the ${source}`;
}
