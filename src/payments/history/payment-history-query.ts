import { type Prisma } from '../../generated/prisma/client.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';

/**
 * Step 30's history vocabulary: what `GET /v1/payments` accepts, and the `WHERE` clause that
 * answers it.
 *
 * ## Why this is a module rather than eight lines inside `PaymentsService`
 *
 * Because the interesting part of a filterable list is not the query, it is the *parsing* of what
 * a client sent - and that is the part a test can drive exhaustively without a database, HTTP, or
 * a fake Prisma client. The same split `classifyRecipientQuery` makes for Step 21: the module owns
 * what a value means and refuses what it cannot mean, the service owns the database and turns a
 * refusal into a status code. Every branch below is a case in `payment-history-query.spec.ts`.
 *
 * ## Two callers, one definition of "my payment"
 *
 * `GET /v1/payments/:id` and `GET /v1/payments` both have to answer "may this caller see this
 * row", and they have to answer it the same way or a payment visible in the list could 404 on its
 * own detail screen. That predicate is `membershipWhere` below, and both paths call it - the same
 * arrangement `RecipientsService.assertPayableRecipient` has for "may this account be paid".
 *
 * The predicate is **membership, not ownership**: a caller sees money they sent *and* money they
 * received, which is what makes a payment appear once on each side of a transaction. A stranger's
 * id reaching this clause finds nothing, which is the whole of the access control - there is no
 * second check, by design, because a second check is a second place for the two to disagree.
 *
 * ## Empty values: refused where there is something to be wrong about
 *
 * `?direction=` and `?status=` are read as *not provided*, because "no filter" is a real request
 * and an always-appended key with nothing in it is how clients spell it. `?from=`, `?to=` and
 * `?limit=` are refused when empty: each names a specific value, and the empty string is not it.
 * The asymmetry is deliberate and is asserted in the spec, rather than being left for a reader to
 * infer from the code.
 */

/**
 * Payments in a page when the client does not say. Twenty is a screenful of history with a little
 * to scroll: fewer than this and the client is paginating a list it has already fetched.
 */
export const PAYMENT_HISTORY_DEFAULT_LIMIT = 20;

/**
 * Ceiling on a page.
 *
 * A cap rather than a refusal, and that is the one place this endpoint deliberately differs from
 * Step 21's `limit`. There, `limit` prices *sweeping the directory* and silently returning twenty
 * handles to someone who asked for a thousand would hide a refusal from a sweep. Here the caller
 * is reading their own money: there is nothing to protect, a page is a page, and `hasMore` says
 * whether there is another one. Asking for more than this gets this many and a `hasMore` that is
 * `true`.
 */
export const PAYMENT_HISTORY_MAX_LIMIT = 50;

/** Which side of a payment's two accounts the caller is asking about. */
export const PAYMENT_HISTORY_DIRECTIONS = ['sent', 'received', 'both'] as const;

export type PaymentDirectionFilter = (typeof PAYMENT_HISTORY_DIRECTIONS)[number];

/**
 * The side one row is on.
 *
 * Never `both`, and that is not a narrowing for the type's sake: a `transactions` row has one
 * sender and one recipient, so a row a caller is on both sides of is a payment they sent
 * themselves - which `POST /v1/payments` refuses (`assertNotSelf`). `directionFor` answers `sent`
 * if that ever changes, and the docblock there says why.
 */
export type PaymentDirection = Exclude<PaymentDirectionFilter, 'both'>;

/**
 * The four statuses, read off the generated enum rather than spelled again.
 *
 * The list exists for two readers - the parser below and the DTO's Swagger enum - and deriving it
 * is what stops a fifth status from being addable to one of them and not the other.
 */
export const PAYMENT_HISTORY_STATUSES = Object.values(TransactionStatus);

/**
 * The query as it arrives: raw strings, because the DTO deliberately does not interpret them.
 *
 * `limit` is a string here for the same reason `amount` is in `CreatePaymentDto`: what arrives is
 * text, and the layer that decides what the text means is this module. A DTO that coerced and
 * clamped would either duplicate the rules below or refuse a value this module is specified to
 * clamp - and a rule in two places is a rule that can disagree with itself.
 */
export interface RawPaymentHistoryQuery {
  readonly direction?: string | undefined;
  readonly status?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: string | undefined;
}

/** The query as it is run: defaults applied, bounds clamped, refusals already thrown. */
export interface PaymentHistoryQuery {
  readonly direction: PaymentDirectionFilter;
  readonly status: TransactionStatus | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly limit: number;
}

/**
 * Why a history query could not be read.
 *
 * One member per parameter plus `range`, so the sentence a client is shown can name the parameter
 * it has to fix - which is the difference between a 400 a client can act on and "invalid query".
 */
export type HistoryQueryProblem = 'direction' | 'status' | 'limit' | 'from' | 'to' | 'range';

/**
 * Thrown by `parsePaymentHistoryQuery`.
 *
 * Not an `HttpException`, for the same reason `UnsearchableQueryError` is not: this is a fact about
 * the input, and the caller decides what it means over the wire (a 400 carrying
 * `invalidHistoryQueryMessage`).
 */
export class InvalidHistoryQueryError extends Error {
  constructor(
    readonly problem: HistoryQueryProblem,
    /** The value as submitted, so the log line can say which input was refused. */
    readonly input: string,
  ) {
    super(`payment history query refused (${problem}): ${input}`);
    this.name = 'InvalidHistoryQueryError';
  }
}

/**
 * One sentence per refusal, written where the HTTP boundary is.
 *
 * It names the parameter and the shape that works, because whoever hits this is wiring a filter to
 * a query string, and the useful answer is the value that would have been accepted.
 */
export function invalidHistoryQueryMessage(problem: HistoryQueryProblem): string {
  switch (problem) {
    case 'direction':
      return `direction has to be one of ${PAYMENT_HISTORY_DIRECTIONS.join(', ')}.`;
    case 'status':
      return `status has to be one of ${PAYMENT_HISTORY_STATUSES.join(', ')}.`;
    case 'limit':
      return `limit has to be a whole number of payments. It is capped at ${PAYMENT_HISTORY_MAX_LIMIT}.`;
    case 'from':
      return 'from has to be an ISO-8601 instant, like 2026-09-01T00:00:00.000Z.';
    case 'to':
      return 'to has to be an ISO-8601 instant, like 2026-09-30T23:59:59.999Z.';
    case 'range':
      return 'from has to be earlier than to: a range the other way round can only ever match nothing.';
  }
}

/**
 * Reads the query the way the list is about to be run.
 *
 * The only function in this module that throws, and it throws only `InvalidHistoryQueryError`:
 * every branch below is pure, so a query that gets past this point reaches the database.
 */
export function parsePaymentHistoryQuery(raw: RawPaymentHistoryQuery): PaymentHistoryQuery {
  const direction = parseDirection(raw.direction);
  const status = parseStatus(raw.status);
  const from = parseInstantOrNull(raw.from, 'from');
  const to = parseInstantOrNull(raw.to, 'to');
  const limit = parseLimit(raw.limit);

  if (from !== null && to !== null && from.getTime() > to.getTime()) {
    throw new InvalidHistoryQueryError('range', `${raw.from ?? ''} > ${raw.to ?? ''}`);
  }

  return { direction, status, from, to, limit };
}

/** `sent`, `received` or `both`, defaulting to `both`. An empty value means "not provided". */
function parseDirection(value: string | undefined): PaymentDirectionFilter {
  if (value === undefined || value === '') {
    return 'both';
  }

  const found = PAYMENT_HISTORY_DIRECTIONS.find((candidate) => candidate === value);

  if (found === undefined) {
    throw new InvalidHistoryQueryError('direction', value);
  }

  return found;
}

/** One of the four statuses, defaulting to no filter. An empty value means "not provided". */
function parseStatus(value: string | undefined): TransactionStatus | null {
  if (value === undefined || value === '') {
    return null;
  }

  const found = PAYMENT_HISTORY_STATUSES.find((candidate) => candidate === value);

  if (found === undefined) {
    throw new InvalidHistoryQueryError('status', value);
  }

  return found;
}

/**
 * `YYYY-MM-DD`, optionally with a time and a zone: the two shapes this endpoint calls an instant.
 *
 * The pattern is checked *as well as* `Date`'s own parse, and each half earns its place. The
 * pattern refuses what a lenient parser would silently accept (`2026-9-1`, `yesterday`), the parse
 * refuses what the parser will not resolve, and `isRealCalendarDate` refuses what a lenient parser
 * would silently *roll over* - `2026-02-31` is not the 3rd of March, it is a typo in a filter.
 */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/;

/** The leading calendar date of a value that has passed `INSTANT_PATTERN`. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Whether the leading `YYYY-MM-DD` is a date that exists.
 *
 * Because `new Date('2026-02-31')` does not fail - it rolls over to the 3rd of March - and a filter
 * built from a bad default would then quietly mean a range nobody asked for. The check is a round
 * trip through `Date.UTC`, which is the only thing that can tell a real date from a date-shaped
 * string: February has 29 days in 2028 and 28 in 2026, and no regular expression knows that.
 */
function isRealCalendarDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text);

  if (parts === null) {
    return false;
  }

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));

  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * The instant, or a refusal - and a date-only value is midnight UTC of that day, nothing else.
 *
 * Stated rather than smoothed over, because the smoothing is the bug: `to=2026-09-30` quietly
 * meaning "the end of the 30th" would be a hidden `+23:59:59.999`, and a client that wants the
 * whole day can pass the whole day. Both bounds are **inclusive**, so they read `>=` and `<=`
 * against `created_at` rather than `>` and `<`.
 */
function parseInstantOrNull(value: string | undefined, problem: 'from' | 'to'): Date | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  const parsed = new Date(trimmed);

  if (
    !INSTANT_PATTERN.test(trimmed) ||
    !isRealCalendarDate(trimmed) ||
    Number.isNaN(parsed.getTime())
  ) {
    throw new InvalidHistoryQueryError(problem, value);
  }

  return parsed;
}

/** Digits only, and nothing else - so `1.5`, `1e2`, `-1` and `''` are all refusals. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * The page size, defaulted and clamped.
 *
 * Refused when it is not a whole number at all (a typo, a `1.5`, an empty value) and *clamped*
 * when it is a whole number and out of range - see `PAYMENT_HISTORY_MAX_LIMIT` for why a cap here
 * is a clamp where Step 21's is a refusal. `Number` is exact on a `/^\d+$/` string, so this is the
 * only arithmetic in the file and it is on a page size, never on money.
 */
function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return PAYMENT_HISTORY_DEFAULT_LIMIT;
  }

  const text = value.trim();

  if (!WHOLE_NUMBER.test(text)) {
    throw new InvalidHistoryQueryError('limit', value);
  }

  return Math.min(Math.max(Number(text), 1), PAYMENT_HISTORY_MAX_LIMIT);
}

/**
 * The rows one caller is on one side of - the whole of Step 30's access control.
 *
 * Two equality reads on the model's own indexes (`@@index([senderId, status])` and
 * `@@index([recipientId, createdAt])`) rather than one clever predicate, which is why `both` is an
 * `OR` over the two columns. A stranger's id matches neither branch, so "not mine" and "does not
 * exist" are one answer - and the endpoint is therefore not an oracle for whether a payment id
 * exists, the same rule `RecipientsController`'s 404 records for account ids.
 */
export function membershipWhere(
  userId: string,
  direction: PaymentDirectionFilter,
): Prisma.TransactionWhereInput {
  switch (direction) {
    case 'sent':
      return { senderId: userId };
    case 'received':
      return { recipientId: userId };
    case 'both':
      return { OR: [{ senderId: userId }, { recipientId: userId }] };
  }
}

/**
 * The `WHERE` clause for one page of one caller's history.
 *
 * Membership first, filters spread on top, so no filter can *widen* the scope: the shape here can
 * only ever narrow what `membershipWhere` allows. That is the property worth keeping, and it is
 * why each filter is its own clause rather than a second top-level `OR`.
 */
export function buildPaymentHistoryWhere(
  userId: string,
  query: PaymentHistoryQuery,
): Prisma.TransactionWhereInput {
  const window = createdAtWindow(query.from, query.to);

  return {
    ...membershipWhere(userId, query.direction),
    ...(query.status === null ? {} : { status: query.status }),
    ...(window === undefined ? {} : { createdAt: window }),
  };
}

/** The inclusive `created_at` window, or `undefined` when neither bound was given. */
function createdAtWindow(
  from: Date | null,
  to: Date | null,
): Prisma.DateTimeFilter<'Transaction'> | undefined {
  if (from === null && to === null) {
    return undefined;
  }

  return { ...(from === null ? {} : { gte: from }), ...(to === null ? {} : { lte: to }) };
}

/**
 * Newest first, with the id as a tiebreak.
 *
 * The tiebreak is not decoration. `created_at` is a timestamp, two rows written in the same
 * millisecond order arbitrarily without it, and "arbitrarily" is exactly what a page boundary must
 * not be: a boundary drawn on an unstable order can show a client the same payment twice and hide
 * another one entirely. `id` is a random UUID, so it is not a chronology - it is only a way to make
 * the order total.
 */
export const PAYMENT_HISTORY_ORDER: Prisma.TransactionOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/**
 * Which side of a row this caller is on.
 *
 * Read from the row rather than from the query, because the query says what was *asked for*
 * (`both`) and the row says what it *is* - and a client rendering "sent" or "received" needs the
 * latter. `senderId` wins when a caller is on both sides, which cannot happen today
 * (`assertNotSelf` refuses a self-payment); the order is stated so that the day it can, the answer
 * is a decision rather than an accident of which branch was written first.
 */
export function directionFor(
  parties: { readonly senderId: string; readonly recipientId: string },
  userId: string,
): PaymentDirection {
  return parties.senderId === userId ? 'sent' : 'received';
}

/**
 * One page from `limit + 1` rows.
 *
 * The `+ 1` fetch is the whole of `hasMore`: asking for one row more than a page can hold and
 * discarding it costs one row, and the answer cannot disagree with the page the client is looking
 * at - where a second `count()` can, because it is a different query at a different moment.
 * Generic so the same function serves the DTO mapping and the spec's plain objects.
 */
export function takePage<T>(
  rows: readonly T[],
  limit: number,
): { readonly items: T[]; readonly hasMore: boolean } {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
