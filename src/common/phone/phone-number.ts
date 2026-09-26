import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Thrown when a submitted phone number cannot be turned into E.164.
 *
 * Deliberately *not* an `HttpException`: this is a phone-number-level fact, and
 * the normalizer is used from places that are not HTTP requests (a job, a
 * script). The registration endpoint maps it onto a 400 at the edge, so there is
 * still exactly one place that decides what a malformed number looks like over
 * the wire.
 */
export class InvalidPhoneNumberError extends Error {
  constructor(
    /** The value as submitted, so the caller can say which input was rejected. */
    readonly input: string,
    detail?: string,
  ) {
    super(
      detail === undefined
        ? `"${input}" is not a valid phone number`
        : `"${input}" is not a valid phone number (${detail})`,
    );
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * E.164 as it is stored and looked up: `+`, a non-zero country code, and at most
 * 15 digits in total (8 is not a real minimum for the countries this API serves,
 * but it keeps a truncated input from becoming a row).
 *
 * Asserted rather than trusted: the column is `@unique`, so a number that
 * arrives here in some other spelling would be stored as a *second* row for a
 * person who is already registered. `libphonenumber` documents `number` as
 * E.164, which is exactly the kind of promise worth failing on if it ever stops
 * being true.
 */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Phone number normalization (Step 9).
 *
 * One job: turn whatever a person typed into the one spelling the database, the
 * lookup and Africa's Talking all agree on. `024 123 4567`, `+2330241234567`,
 * `233241234567` and `00233241234567` are four ways of writing the same Ghanaian
 * number, and the register endpoint has to recognise an existing user
 * *regardless of which one was submitted* - `phone_number` is under a unique
 * index, so normalizing after the lookup would be too late.
 *
 * `libphonenumber-js` rather than a regex: the trunk-prefix rules are
 * country-specific (`+2330241234567` parses as `+233241234567` because Ghana's
 * national prefix is `0`, which no hand-rolled pattern gets right), the same
 * digit string is a valid number in one country and an invalid one in another,
 * and the metadata is maintained by people who track number-plan changes.
 *
 * `defaultRegion` only decides how a *local* spelling is read. A number that
 * carries its own country code (`+2348031234567`, `00233241234567`) is parsed on
 * its own terms, which is what makes this safe to use for a diaspora user.
 *
 * Throws `InvalidPhoneNumberError` for anything that cannot be normalized - the
 * caller decides what that means (a 400, a rejected row, a retry).
 */
export function normalizePhoneNumber(input: string, defaultRegion: CountryCode): string {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw new InvalidPhoneNumberError(input, 'nothing was submitted');
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);

  if (!parsed) {
    throw new InvalidPhoneNumberError(input, 'not a phone number in any format');
  }

  // `isValid()` rather than `isPossible()`: a number can be the right shape and
  // still not exist in the country's plan (`02412345` parses, and is not a real
  // Ghanaian number), and that is the difference between "we texted a stranger"
  // and "we rejected a typo".
  if (!parsed.isValid()) {
    throw new InvalidPhoneNumberError(input, 'not a valid number for its country');
  }

  if (!E164_PATTERN.test(parsed.number)) {
    throw new InvalidPhoneNumberError(input, `did not normalize to E.164 (${parsed.number})`);
  }

  return parsed.number;
}

/**
 * Shortens a phone number for logs: `+233241234567` -> `+233*****4567`.
 *
 * Logs are the one place a phone number leaks by accident, and full numbers in an
 * aggregator are a privacy problem that outlives the request (a log line is
 * retained far longer than a database row we chose to delete). The last four
 * digits are kept because that is what a support conversation identifies a number
 * by, and the country code so a failure is attributable to the right region.
 *
 * Short inputs lose more of the middle rather than the ends, so nothing about the
 * contract depends on the number actually being valid E.164.
 */
export function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length <= 7) {
    return '*'.repeat(phoneNumber.length);
  }

  return `${phoneNumber.slice(0, 4)}${'*'.repeat(phoneNumber.length - 8)}${phoneNumber.slice(-4)}`;
}
