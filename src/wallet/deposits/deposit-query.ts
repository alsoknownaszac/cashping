/**
 * `GET /v1/wallet/deposits`'s query vocabulary: what it accepts, and how a value is read.
 *
 * The same split `payment-history-query.ts` makes, for the same reason: the interesting part of a
 * paged read is the *parsing* of what a client sent, and this module is where that is written so
 * a spec can drive every branch without a network, an HTTP server, or a fake Horizon. The DTO
 * declares the fields as strings and this module decides what a string means.
 *
 * Only two parameters, because a Horizon read has only two: how many, and where to resume.
 * There is no filter here that the ledger cannot answer from a payments query - the deposits
 * read is "everything paid into this wallet", ordered by Horizon.
 */

/**
 * Deposits in a page when the client does not say.
 *
 * Twenty matches `PAYMENT_HISTORY_DEFAULT_LIMIT`: a screenful with a little to scroll, and the
 * same number on both money lists so a client does not have to learn a second default.
 */
export const DEPOSITS_DEFAULT_LIMIT = 20;

/**
 * Ceiling on a page.
 *
 * A cap rather than a refusal, exactly as `PAYMENT_HISTORY_MAX_LIMIT` is: the caller is reading
 * their own wallet, a page is a page, and asking for more than this gets this many. Horizon's own
 * hard limit for a payments page is 200, and staying comfortably under it keeps one request from
 * being the thing that times out a screening call.
 */
export const DEPOSITS_MAX_LIMIT = 50;

/** The query as it arrives: raw strings, because the DTO deliberately does not interpret them. */
export interface RawDepositQuery {
  readonly limit?: string | undefined;
  readonly cursor?: string | undefined;
}

/** The query as it is run: defaults applied, bound clamped, refusals already thrown. */
export interface DepositQuery {
  readonly limit: number;
  readonly cursor: string | undefined;
}

/** Why a deposits query could not be read. One member per parameter. */
export type DepositQueryProblem = 'limit' | 'cursor';

/**
 * Thrown by `parseDepositQuery`.
 *
 * Not an `HttpException`, for the same reason `InvalidHistoryQueryError` is not: this is a fact
 * about the input, and the caller decides what it means over the wire (a 400 carrying
 * `invalidDepositQueryMessage`).
 */
export class InvalidDepositQueryError extends Error {
  constructor(
    readonly problem: DepositQueryProblem,
    /** The value as submitted, so the log line can say which input was refused. */
    readonly input: string,
  ) {
    super(`deposits query refused (${problem}): ${input}`);
    this.name = 'InvalidDepositQueryError';
  }
}

/** One sentence per refusal, naming the parameter and the shape that works. */
export function invalidDepositQueryMessage(problem: DepositQueryProblem): string {
  switch (problem) {
    case 'limit':
      return `limit has to be a whole number of deposits. It is capped at ${DEPOSITS_MAX_LIMIT}.`;
    case 'cursor':
      return 'cursor has to be a page token from a previous response.';
  }
}

/**
 * Reads the query, applying the default limit, clamping an out-of-range one, and refusing one
 * that is not a whole number.
 *
 * `limit` is *clamped* rather than refused when it is out of range, which is the one behaviour
 * worth stating: `limit=1000` is a client asking for a page at least as big as this endpoint is
 * willing to serve, and silently serving the maximum is friendlier than a 400 - the same call
 * the payments history makes. A value that is not a whole number at all (`limit=abc`, `limit=1.5`)
 * is refused, because there is no limit it could be.
 */
export function parseDepositQuery(raw: RawDepositQuery): DepositQuery {
  return { limit: parseLimit(raw.limit), cursor: parseCursor(raw.cursor) };
}

/** A whole number of deposits, defaulted and clamped; anything else is refused. */
function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEPOSITS_DEFAULT_LIMIT;
  }

  // Empty is "the key was sent with nothing in it", which is not the same as "not provided": a
  // specific value was meant, and `''` is not one. The same asymmetry `payment-history-query.ts`
  // records for `from`/`to`/`limit`.
  if (value.trim() === '') {
    throw new InvalidDepositQueryError('limit', value);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new InvalidDepositQueryError('limit', value);
  }

  return Math.min(Math.max(parsed, 1), DEPOSITS_MAX_LIMIT);
}

/** The cursor to resume from, or `undefined` to start at the newest deposit. */
function parseCursor(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim() === '') {
    throw new InvalidDepositQueryError('cursor', value);
  }

  // Not validated against a format: a paging token is an opaque string Horizon issued, and the
  // only thing this app can say about a wrong one is what Horizon says when it is asked - which
  // is a refusal from Horizon, not a 400 invented here.
  return value;
}
