/**
 * The parts of the step-up token's contract that the signer and the verifier have to agree
 * on (Step 34a), in one file for the reason `access-token.ts` gives about the access
 * token's: a drift between the two sides is an exception at best, and an *accepted
 * forgery* at worst.
 *
 * They live in `pin/` rather than beside the session's because they are a different
 * credential with a different job: an access token says *who you are* and lives for a
 * quarter of an hour; a step-up token says *you gave your PIN a moment ago* and lives for
 * five minutes. Nothing that accepts one should accept the other.
 */

/**
 * Who issued the token.
 *
 * The same issuer as the access token, because it is the same service: `cashping`. The
 * separation between the two tokens is carried by the audience below, not by pretending to
 * be two systems.
 */
export const STEP_UP_TOKEN_ISSUER = 'cashping';

/**
 * Who the token is for, and the reason this is not `cashping-api`.
 *
 * The audience is what stops one of these from standing in for the other. Both are signed
 * with the same `JWT_SECRET` - there is one signing key, deliberately - so without a
 * distinct audience a step-up token would be a valid *access* token: `JwtStrategy` would
 * accept it, look up the user and sign in a session that was never authenticated. The
 * reverse matters too, and is the reason `StepUpTokenService.verify` names this audience
 * explicitly: an access token must not be usable to authorise a payment.
 */
export const STEP_UP_TOKEN_AUDIENCE = 'cashping-step-up';

/**
 * HS256, the algorithm the session tokens use, for the same reason: one algorithm, stated
 * rather than inferred, so the classic "alg confusion" attacks (a token that asks to be
 * verified as `none`, or as a public-key token) have nothing to work with.
 */
export const STEP_UP_TOKEN_ALGORITHM = 'HS256';

/**
 * The header a step-up token is presented in.
 *
 * A dedicated header rather than a field in the payment body, and that is a decision worth
 * spelling out: a body field would be *payment data*, which means it would be validated
 * against the payment DTO, stored by the idempotency store, and echoed in logs of request
 * bodies. A credential belongs in a header, next to the `Authorization` header it is a
 * second factor for - and a header is the one place the guard can look without the handler
 * (or the DTO) knowing the credential exists.
 *
 * Deliberately not `Authorization: Step-Up <token>`: that would put two credentials in one
 * header, and a client that sent the wrong one would look authenticated-but-refused rather
 * than asking for the thing it is missing.
 */
export const STEP_UP_TOKEN_HEADER = 'x-step-up-token';

/**
 * The claims this API reads out of a verified step-up token.
 *
 * `sub` and nothing else, exactly as the access token carries it and for the same reason:
 * anything else (`pinVerifiedAt`, an attempt count) would be a cached copy of a row that can
 * change, and the token's whole claim is "the PIN was proved before this token was issued".
 */
export interface StepUpTokenClaims {
  /** The user id the PIN was proved for. */
  sub: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Issuer, checked against `STEP_UP_TOKEN_ISSUER`. */
  iss: string;
  /** Audience, checked against `STEP_UP_TOKEN_AUDIENCE`. */
  aud: string;
}
