import { type CountryCode } from 'libphonenumber-js';
import { InvalidPhoneNumberError, normalizePhoneNumber } from '../../common/phone/phone-number.js';
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  handleProblem,
  normalizeHandle,
  type HandleProblem,
} from '../../identity/handle/handle.js';

/**
 * What a recipient search accepts, and what it refuses (Step 21).
 *
 * ## Two readings of one `q`, and only one of them matches by prefix
 *
 * A phone number is matched **exactly**, never by prefix: the whole point of Step 21's rate
 * limit is that sweeping numbers to learn which are registered must cost something, and a
 * prefix match on `phone_number` would answer "is anyone in this range registered" in one
 * request, without the range ever being typed out. So `+2332412345` is not a search for every
 * number starting with those digits - it is a string that is not a valid phone number (and,
 * being all digits, is read as a handle prefix instead - see below).
 *
 * A handle is matched by prefix, because that is what a person does when they half-remember a
 * name (`mir` for `miriam`), and because the prefix path returns *handles* rather than
 * numbers: a list of names matching what was typed, which is the disclosure a directory lookup
 * is allowed to make.
 *
 * ## A value that is not a number is read as a handle rather than refused
 *
 * `normalizePhoneNumber` is the Step 9 utility the build sequence names for this, and it is
 * tried first: any format a person might type (`024 123 4567`, `+233241234567`,
 * `00233241234567`) reaches the query as one E.164 string, so the caller never has to know
 * which spelling the database holds. When it throws, the input is *not* an error yet - it is
 * most likely a handle being typed - so it is classified instead.
 *
 * ## Reserved words are deliberately not refused here
 *
 * `handleProblem` answers "may this become someone's handle", and the reserved-word list is
 * policy about *registration*: nobody can hold `admin`. A search is a different question, and
 * looking for `admin` is a reasonable way to find nobody. Every other rule - minimum and
 * maximum length, allowed characters - is the same rule, so it comes from that one file rather
 * than being re-typed here, where it could drift.
 */

/**
 * Handles returned when the client does not say how many it wants.
 *
 * Ten is a picker above a keyboard, not a directory listing: a screen that shows fewer
 * candidates than this has seen the whole answer, and `hasMore` says when it has not.
 */
export const RECIPIENT_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Ceiling on `limit`, and the reason there is one.
 *
 * An unbounded limit on a prefix match is an address-book export: `q=a&limit=100000` would
 * return every handle containing an `a`. Twenty candidates is more than a human reads, and a
 * sweep of the namespace has to be many requests - which is what the rate limiter counts.
 */
export const RECIPIENT_SEARCH_MAX_LIMIT = 20;

/**
 * How `q` was read, as the classification the lookup runs.
 *
 * A union rather than a normalised string plus a flag: `phoneNumber` is E.164 and `prefix` is
 * a canonical handle prefix, and the two are never interchangeable - the phone one is an
 * equality, the handle one a range.
 */
export type RecipientQuery =
  | { readonly kind: 'phone'; readonly phoneNumber: string }
  | { readonly kind: 'handle'; readonly prefix: string };

/**
 * Why `q` could not be read as either.
 *
 * `HandleProblem`'s members rather than a parallel set of names: `too_short`, `too_long` and
 * `characters` mean exactly what they mean at registration, and `empty` is the one case that
 * only exists here.
 *
 * `reserved` is excluded on purpose, and the exclusion carries a decision: `classifyRecipientQuery`
 * lets a reserved word through as a handle search, so there is no refusal sentence to write for
 * it - and this type says so, rather than leaving an unreachable branch in
 * `unsearchableQueryMessage` for a reviewer to wonder about.
 */
export type UnsearchableQueryReason = 'empty' | Exclude<HandleProblem, 'reserved'>;

/**
 * Thrown by `classifyRecipientQuery`.
 *
 * Not an `HttpException`, for the same reason `InvalidPhoneNumberError` is not: this is a fact
 * about the input, and the caller decides what it means over the wire (a 400 with a sentence
 * naming the rule).
 */
export class UnsearchableQueryError extends Error {
  constructor(
    readonly reason: UnsearchableQueryReason,
    /** The value as submitted, so the caller can say which input was refused. */
    readonly input: string,
  ) {
    super(`"${input}" is not a phone number or a usable handle prefix (${reason})`);
    this.name = 'UnsearchableQueryError';
  }
}

/**
 * Reads `q` the way the query is about to be run: a phone number to match exactly, or a handle
 * prefix to match by range.
 *
 * Throws `UnsearchableQueryError` when it is neither, which is the only way this can fail -
 * both branches are pure, so a search that gets past this point reaches the database.
 */
export function classifyRecipientQuery(input: string, defaultRegion: CountryCode): RecipientQuery {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw new UnsearchableQueryError('empty', input);
  }

  try {
    return { kind: 'phone', phoneNumber: normalizePhoneNumber(trimmed, defaultRegion) };
  } catch (error) {
    // Anything that is not "this is not a number" is a genuine failure of the normalizer and
    // belongs to its caller; only the expected one falls through to the handle reading.
    if (!(error instanceof InvalidPhoneNumberError)) {
      throw error;
    }
  }

  const prefix = normalizeHandle(trimmed);
  const problem = handleProblem(trimmed);

  if (problem !== null && problem !== 'reserved') {
    throw new UnsearchableQueryError(problem, input);
  }

  return { kind: 'handle', prefix };
}

/**
 * One sentence per refusal, written where the HTTP boundary is.
 *
 * It names the rule that was broken rather than saying "invalid search", because the two
 * reasons a person hits this are ordinary mistakes: a number typed with digits missing, and a
 * handle typed one character too short.
 */
export function unsearchableQueryMessage(reason: UnsearchableQueryReason): string {
  switch (reason) {
    case 'empty':
      return 'Search by phone number or handle: pass `q`.';
    case 'too_short':
      return `A handle search needs at least ${HANDLE_MIN_LENGTH} characters.`;
    case 'too_long':
      return `A handle search can be at most ${HANDLE_MAX_LENGTH} characters.`;
    case 'characters':
      return 'A search is a phone number, or a handle made of letters, digits and underscores.';
  }
}
