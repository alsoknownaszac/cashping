/**
 * The parts of the access-token contract that the signer and the verifier have to
 * agree on (Step 16).
 *
 * They live together because they are a pair of agreements, and each one fails in its
 * own quiet way when they drift: an algorithm mismatch is an exception at the first
 * request, but an issuer or audience mismatch is just "401" - and a *missing* check
 * is nothing at all until someone gets hold of a token this API did not issue.
 *
 * `JwtModule` signs with these and `JwtStrategy` verifies with them, so there is one
 * definition of each rather than one per side.
 */

/**
 * Who issued the token.
 *
 * Checked on verify so that a token minted by another service that happens to share
 * a secret (a staging deployment, an internal tool, a copied `.env`) is not accepted
 * here as authentication for a Cashping user.
 */
export const ACCESS_TOKEN_ISSUER = 'cashping';

/**
 * Who the token is for.
 *
 * The audience is the API itself, not the app: if a second consumer (an admin
 * console, a partner integration) ever needs tokens, it gets its own audience rather
 * than access to this one.
 */
export const ACCESS_TOKEN_AUDIENCE = 'cashping-api';

/**
 * HS256: HMAC-SHA256 over a shared secret.
 *
 * Only one algorithm, not a list. `verify` is told exactly this and refuses anything
 * else, which is what closes the classic JWT confusion bugs (`alg: none`, or an RS256
 * token verified as if it were HMAC - "alg confusion"): an attacker cannot pick the
 * algorithm by editing the header, because the header is not consulted.
 *
 * The secret is `JWT_SECRET`, floored at 32 characters by `validation.schema.ts`.
 * The move to RS256 (public verification, no shared secret) is a Day-3 decision and
 * does not change this file's shape.
 */
export const ACCESS_TOKEN_ALGORITHM = 'HS256';

/**
 * The claims this API reads out of a verified access token.
 *
 * `sub` is the only thing signed on purpose: everything else (handle, status, role)
 * would be a cached copy of a database row, and a stale copy is a second, quieter
 * source of truth for authorisation. `iat`, `exp`, `iss` and `aud` are not signed by
 * this class - `jsonwebtoken` adds them from the signing options and verifies them
 * here, which is why they are typed rather than optional.
 */
export interface AccessTokenClaims {
  /** The user id. */
  sub: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Issuer, checked against `ACCESS_TOKEN_ISSUER`. */
  iss: string;
  /** Audience, checked against `ACCESS_TOKEN_AUDIENCE`. */
  aud: string;
}
