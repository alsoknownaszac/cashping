import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque refresh tokens (Step 16).
 *
 * Three small pure functions with no dependencies, which is the point: the token
 * format, the digest and the shape check are the parts of the session design whose
 * mistakes *hide*. A truncated token is still a string. A hash that is not the one
 * the lookup computes does not throw - it returns "not found", which reads exactly
 * like an expired session. Keeping these separate and separately tested is what
 * turns those silent failures into failing tests.
 */

/**
 * Bytes of CSPRNG output behind one refresh token.
 *
 * 32 bytes - 256 bits - because this is the credential that lives for a month. It is
 * the one secret in the system that is worth brute-forcing, so the margin is set
 * where that stops being a question: 2^256 is not reached by any amount of money.
 */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Characters in a generated token: 32 bytes is 43 base64url characters (the 44th
 * would be the `=` that the unpadded alphabet drops).
 *
 * A sibling of `REFRESH_TOKEN_BYTES` rather than something callers derive, and the
 * only consumer is the shape check below, which builds its pattern from this value.
 * `refresh-token.spec.ts` asserts a generated token is exactly this long, so the two
 * cannot drift apart into a check that rejects every real token.
 */
export const REFRESH_TOKEN_LENGTH = 43;

/** The alphabet and length of a token we could have issued. */
const REFRESH_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${REFRESH_TOKEN_LENGTH}}$`);

/**
 * Generates a refresh token: `REFRESH_TOKEN_BYTES` random bytes, base64url.
 *
 * `randomBytes` (a CSPRNG) and not a UUID, a timestamp, a counter or anything
 * home-made: a refresh token is the only thing an attacker needs to hold a session,
 * so predicting one is total compromise, and the difference between `Math.random()`
 * and this is invisible in review.
 *
 * base64url rather than hex or plain base64 because the value travels - a JSON body
 * today, a query string, a log or a shell argument in some future debugging session
 * - and `+`, `/` and `=` are the characters that survive none of those intact.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * The digest stored in `refresh_tokens.token_hash`.
 *
 * SHA-256, not bcrypt or argon2, which is the opposite of the choice made for OTP
 * codes and passwords - deliberately. A slow hash exists to make a *guessable* secret
 * expensive to guess; the input here is 256 random bits, so there is nothing to guess
 * and a work factor would buy nothing. It would also cost something: the digest is
 * looked up by value, so it has to be deterministic, and every refresh would pay the
 * KDF. (The stored value is still a hash rather than the token, so a database leak
 * hands over no working sessions.)
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether a string could be one of our tokens, asked before anything expensive.
 *
 * A shape check, not a validity check: it cannot tell a live token from a revoked
 * one, and it must not be treated as authorisation. What it is for is keeping
 * garbage - an empty string, an access token pasted into the wrong field, a payload
 * a parser choked on - from reaching the database, and giving every malformed value
 * the same answer as a revoked one instead of a distinguishable error.
 */
export function looksLikeRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_PATTERN.test(token);
}
