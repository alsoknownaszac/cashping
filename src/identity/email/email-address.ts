/**
 * An email address as stored, and the one definition of what that means (Step 34c).
 *
 * The same job `phone/phone-number.ts` does for a number, for the same reason: an address is
 * an *identity* here - it is unique in `users`, it is what a verification code is sent to,
 * and two spellings of one mailbox have to be one row. So normalization happens once, at the
 * edge, and every lookup and write uses its output rather than the submitted string.
 *
 * What "normalize" means is deliberately narrow: trim, and lower-case the whole address.
 * The local part of an address is technically case-sensitive, and lower-casing it is a
 * simplification - the one the plan chooses ("uniqueness is on the stored, lower-cased
 * address, following the one-spelling-per-identity rule `phoneNumber` already follows"),
 * because every real provider treats `Miriam@Example.com` and `miriam@example.com` as the
 * same mailbox and refusing to would be a support ticket with no fix a user can apply.
 */

/**
 * The shape this API accepts, and nothing more.
 *
 * Deliberately one character class either side of the `@` rather than the full RFC 5322
 * grammar: that grammar accepts comments, quoted local parts and address literals, and a
 * regex that implements it is famously one that rejects valid addresses and accepts invalid
 * ones. This accepts what a person types - `local@domain.tld`, at least one dot in the
 * domain - and refuses whitespace anywhere, because the addresses this check exists to keep
 * out are the ones the *sender* cannot deliver to rather than the ones an RFC would.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * The ceiling every part of an email system agrees on (RFC 5321's 254-octet forward path).
 *
 * A bound rather than a security rule: it stops a body that is really a payload from being
 * carried into a column and an outbound message, and it is the same number a provider would
 * refuse with a bounce the user could not act on.
 */
export const MAX_EMAIL_LENGTH = 254;

/** Why an address was refused. */
export type EmailAddressProblem = 'shape' | 'too_long';

/**
 * The address is not one this API will store or send to.
 *
 * A typed error with the reason named, like `InvalidHandleError`: `AuthService` turns it
 * into a 400 whose message says which rule was broken, because "invalid email" tells the
 * user nothing about whether to fix a typo or a length.
 */
export class InvalidEmailAddressError extends Error {
  constructor(
    readonly input: string,
    readonly problem: EmailAddressProblem,
  ) {
    super(`Invalid email address (${problem})`);
    this.name = 'InvalidEmailAddressError';
  }
}

/**
 * The stored form of a submitted address: trimmed, lower-cased, or a thrown reason.
 *
 * The raw input is carried on the error rather than only the normalized form, so the 400
 * can echo back exactly what was sent - the one thing a user can compare against what they
 * meant to type.
 */
export function normalizeEmailAddress(input: string): string {
  const normalized = input.trim().toLowerCase();

  if (normalized.length > MAX_EMAIL_LENGTH) {
    throw new InvalidEmailAddressError(input, 'too_long');
  }

  if (!EMAIL_PATTERN.test(normalized)) {
    throw new InvalidEmailAddressError(input, 'shape');
  }

  return normalized;
}

/**
 * The masked form of an address: `m***@example.com`.
 *
 * Lives here, next to the rule it belongs to, rather than in the file that happens to log one:
 * this is the file that says what an address *is*, and the mask is part of that - the reason
 * `phone/phone-number.ts` holds `maskPhoneNumber`. A log line is a place an identity can leak
 * from, so the value put in front of a human is the masked form and only the masked form, and
 * there is one definition of what that form is (Step 34c).
 *
 * Enough of the address survives for an operator to recognise the account, and not enough to
 * read back the mailbox: the domain is kept whole (it names no person, and it is what a delivery
 * problem is usually about) while the local part is reduced to its first character.
 */
export function maskEmailAddress(email: string): string {
  const at = email.indexOf('@');

  // Nothing to keep: `a@example.com` would be echoed almost in full, and a value with no `@` at
  // all is not an address, so the safe answer is that there is no safe excerpt of it.
  if (at <= 1) {
    return '***';
  }

  return `${email[0]}***${email.slice(at)}`;
}
