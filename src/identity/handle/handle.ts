/**
 * Handle policy (Step 15): how a submitted handle is normalized, what makes one
 * invalid, and which ones are reserved.
 *
 * A handle is the identifier another user types to send money to someone, which is
 * why its rules live in one module with tests rather than as regexes scattered
 * across a DTO and a service: "is this handle allowed" has exactly one answer, and
 * it has to be the same answer at registration, in a future rename endpoint, and
 * in whatever imports this module next.
 *
 * **Uniqueness is case-insensitive because storage is canonical.** Every handle is
 * lower-cased here before it reaches the database, the same way every phone number
 * is E.164 before it does (Step 9). One spelling per handle means the plain unique
 * index on `handle` *is* the case-insensitive one - `@Miriam` and `@miriam` are
 * both stored as `miriam` and the second one loses. The alternative (storing the
 * display casing and adding a functional `lower(handle)` index) buys back the
 * capitalisation the user typed at the cost of every future lookup having to
 * remember to compare case-insensitively; that is the failure mode this module
 * exists to prevent, and the database enforces the canonical form with a CHECK
 * constraint as a backstop.
 */

/**
 * Length bounds. 3 keeps two-letter names out of the namespace (they are the ones
 * worth squatting), 20 keeps a handle typable and keeps the column a sensible size
 * for a URL and a payment line.
 */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/**
 * The characters a handle may contain, checked *after* normalization - so this is
 * lower case only, and `@Miriam_2` passes because it has become `miriam_2`.
 *
 * Deliberately no leading digit rule: `233` is a fine handle and is not confusable
 * with a phone number, which is always stored with its `+` and country code.
 */
const HANDLE_PATTERN = /^[a-z0-9_]+$/;

/**
 * Handles that must never belong to a user.
 *
 * Every entry here is a name that would let its owner be mistaken for the service
 * itself - to receive a payment meant for "support", to be quoted in a support
 * thread, or to be trusted by someone who did not read the whole handle. Reserved
 * names are cheap to add now and, once real users hold them, expensive to take
 * back: the cost of this list is that we cannot claim these handles ourselves
 * without editing it.
 *
 * Matched after normalization, so the list is lower case and `@Admin` is caught
 * too. Underscore variants are listed explicitly because `_` is an allowed
 * character: `cash_ping` is a different string from `cashping` and just as
 * misleading.
 *
 * Every entry has to be a handle the character, length and case rules would
 * otherwise accept - a reserved word that normalization or the 3-character minimum
 * already rejects (`me`, `@`) is dead weight, and `handle.spec.ts` fails if one is
 * added by mistake.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Generic authority.
  'admin',
  'administrator',
  'root',
  'superuser',
  'sysadmin',
  'moderator',
  'owner',
  'official',
  'staff',
  'team',
  'system',
  'service',
  'security',
  'billing',
  'payments',
  'wallet',
  'api',
  'www',
  // Support-facing names.
  'support',
  'help',
  'helpdesk',
  'info',
  'contact',
  // This service, in the spellings a user would actually try.
  'cashping',
  'cashpingapp',
  'cash_ping',
  'cashpingapp_official',
  'cashping_official',
  'cashpingadmin',
  'cashping_admin',
  'cashpingsupport',
  'cashping_support',
  'cashpinghelp',
  'cashping_help',
]);

/**
 * Why a handle was refused. A union rather than a message: the caller turns it
 * into words (an HTTP body, in `AuthService`), and the tests assert the *reason*
 * rather than a sentence that will be reworded.
 */
export type HandleProblem = 'too_short' | 'too_long' | 'characters' | 'reserved';

/** Thrown by `assertHandleAllowed`. Carries the canonical form that was refused. */
export class InvalidHandleError extends Error {
  constructor(
    readonly problem: HandleProblem,
    /** The normalized handle, i.e. what would have been stored. */
    readonly handle: string,
  ) {
    super(`Handle "${handle}" is not allowed (${problem})`);
    this.name = 'InvalidHandleError';
  }
}

/**
 * Trims, drops one leading `@` and lower-cases.
 *
 * The `@` is accepted because that is how handles are written in the product and
 * in the spec (`@handle`): a user pasting `@miriam` from a chat should not be told
 * their handle contains an illegal character. Only the first one is stripped, so
 * `@@miriam` normalizes to `@miriam` and fails the character rule instead of
 * silently becoming valid.
 */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

/**
 * The reason `input` is not an acceptable handle, or `null` if it is.
 *
 * Length is checked before characters so that a two-character handle containing a
 * space reports the problem the user can actually fix first, and reserved is
 * checked last: it is the only rule that is about *policy* rather than shape.
 */
export function handleProblem(input: string): HandleProblem | null {
  const handle = normalizeHandle(input);

  if (handle.length < HANDLE_MIN_LENGTH) {
    return 'too_short';
  }

  if (handle.length > HANDLE_MAX_LENGTH) {
    return 'too_long';
  }

  if (!HANDLE_PATTERN.test(handle)) {
    return 'characters';
  }

  return RESERVED_HANDLES.has(handle) ? 'reserved' : null;
}

/**
 * Returns the canonical handle, or throws `InvalidHandleError`.
 *
 * Throwing rather than returning a result type because every caller has to reject
 * an invalid handle - there is no path where the answer "this is not a handle" is
 * allowed to continue - and the same shape is used by `normalizePhoneNumber`.
 */
export function assertHandleAllowed(input: string): string {
  const handle = normalizeHandle(input);
  const problem = handleProblem(handle);

  if (problem !== null) {
    throw new InvalidHandleError(problem, handle);
  }

  return handle;
}
