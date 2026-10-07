import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, type HandleProblem } from './handle.js';

/**
 * The sentence one refused handle produces over HTTP.
 *
 * `handle.ts` answers *why* a handle was refused (a `HandleProblem`) and deliberately refuses to
 * put it into words: a union is what `handle.spec.ts` pins, and tests assert the reason rather
 * than a sentence that will be reworded. The words belong at the boundary, and this is that
 * boundary - shared so that the *same* handle is refused in the *same* sentence wherever it is
 * refused. There are two such places: claiming a handle (`AuthService.resolveHandle`, reached by
 * registration and by `PATCH /auth/handle`) and the availability check (`HandlesService`), and a
 * client that shows the availability answer beside the form it belongs to must not show two
 * different accounts of one broken rule depending on which request it made.
 *
 * One sentence per reason rather than one generic message: "a handle needs at least 3 characters"
 * tells the user what to type next, while "invalid handle" ends the signup. Every caller turns
 * this string into the same 400 - a reserved name included, which is a 400 rather than a 409 even
 * though it reads like "taken", because a taken handle can be freed and a reserved one never will
 * be, so waiting and retrying is not a thing the caller can do. That last reasoning lives with the
 * mapping rather than here: see `AuthService.toHandleRejection` and `HandlesService`.
 *
 * `input` is what the caller submitted (`@Miriam`, spaces and all) and `normalized` is the
 * canonical form the rules were applied to, so the length in a too-short or too-long message is
 * the length that actually failed (`"ab" has 2`), not the length a stray `@` would inflate.
 */
export function handleRejectionMessage(
  problem: HandleProblem,
  input: string,
  normalized: string,
): string {
  switch (problem) {
    case 'too_short':
      return `A handle needs at least ${HANDLE_MIN_LENGTH} characters. "${input}" has ${normalized.length}.`;

    case 'too_long':
      return `A handle can be at most ${HANDLE_MAX_LENGTH} characters. "${input}" has ${normalized.length}.`;

    case 'characters':
      return 'A handle can only contain letters, digits and underscores, like "miriam_owusu".';

    case 'reserved':
      return `"@${normalized}" is reserved by Cashping. Please choose another handle.`;
  }
}
