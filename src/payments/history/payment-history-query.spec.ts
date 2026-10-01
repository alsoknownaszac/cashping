import { describe, expect, it } from 'vitest';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import {
  PAYMENT_HISTORY_DEFAULT_LIMIT,
  PAYMENT_HISTORY_DIRECTIONS,
  PAYMENT_HISTORY_MAX_LIMIT,
  PAYMENT_HISTORY_ORDER,
  PAYMENT_HISTORY_STATUSES,
  InvalidHistoryQueryError,
  buildPaymentHistoryWhere,
  directionFor,
  invalidHistoryQueryMessage,
  membershipWhere,
  parsePaymentHistoryQuery,
  takePage,
  type HistoryQueryProblem,
  type RawPaymentHistoryQuery,
} from './payment-history-query.js';

/**
 * Step 30's query vocabulary, as the pure function it is: the whole contract `GET /v1/payments`
 * has with its query string, decided before any query runs - which is why this file needs no
 * database, no HTTP and no Nest.
 *
 * Each group below is a product decision rather than an implementation detail:
 *
 * 1. **Defaults are the whole history.** No parameters means the caller's payments, newest first,
 *    twenty at a time - not an empty page and not an error.
 * 2. **`limit` is clamped, not refused.** This is the one place a page size differs from Step 21's
 *    recipient search, where `limit` prices a sweep and an out-of-range value must be refused so a
 *    sweeping client cannot be told "here is 20" while believing it asked for 1000.
 * 3. **A filter can only narrow.** The membership clause is the access control, and the property
 *    test at the bottom asserts that no combination of filters can ever widen it - the invariant
 *    the whole endpoint's authorisation rests on.
 * 4. **An empty `direction`/`status` is "not provided"; an empty `from`/`to`/`limit` is refused.**
 *    Stated here as a table, because it is a decision rather than an accident of parsing.
 */

const USER = '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41';
const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The refusal `problem` for a raw query, or a failure if it was accepted. */
function problemFor(raw: RawPaymentHistoryQuery): HistoryQueryProblem {
  try {
    parsePaymentHistoryQuery(raw);
  } catch (error) {
    if (error instanceof InvalidHistoryQueryError) {
      return error.problem;
    }

    throw error;
  }

  throw new Error(`expected ${JSON.stringify(raw)} to be refused`);
}

describe('the query a client did not send', () => {
  it('is the whole history, twenty at a time', () => {
    expect(parsePaymentHistoryQuery({})).toEqual({
      direction: 'both',
      status: null,
      from: null,
      to: null,
      limit: PAYMENT_HISTORY_DEFAULT_LIMIT,
    });
  });
});

describe('direction', () => {
  it.each(PAYMENT_HISTORY_DIRECTIONS)('accepts %s', (direction) => {
    expect(parsePaymentHistoryQuery({ direction }).direction).toBe(direction);
  });

  it('reads an empty value as "not provided", because "no filter" is a real request', () => {
    expect(parsePaymentHistoryQuery({ direction: '' }).direction).toBe('both');
  });

  it('refuses anything else, including the right word in the wrong case', () => {
    // Case matters because the wire vocabulary is exact everywhere else in this API (`status` is
    // upper case, `direction` is lower), and a client that gets it wrong should hear about it
    // rather than quietly receive the wrong side of its own history.
    expect(problemFor({ direction: 'sent ' })).toBe('direction');
    expect(problemFor({ direction: 'SENT' })).toBe('direction');
    expect(problemFor({ direction: 'incoming' })).toBe('direction');
    expect(problemFor({ direction: 'all' })).toBe('direction');
  });
});

describe('status', () => {
  it.each(PAYMENT_HISTORY_STATUSES)('accepts %s', (status) => {
    expect(parsePaymentHistoryQuery({ status }).status).toBe(status);
  });

  it('accepted every member of the generated enum, so the two cannot drift', () => {
    expect(PAYMENT_HISTORY_STATUSES).toEqual(Object.values(TransactionStatus));
  });

  it('reads an empty value as "not provided", and omits the clause entirely', () => {
    expect(parsePaymentHistoryQuery({ status: '' }).status).toBeNull();
  });

  it('refuses anything else, including a lower-case spelling of a real status', () => {
    expect(problemFor({ status: 'successful' })).toBe('status');
    expect(problemFor({ status: 'DONE' })).toBe('status');
    expect(problemFor({ status: 'PENDING ' })).toBe('status');
  });
});

describe('from and to', () => {
  it('reads a full instant as exactly that instant', () => {
    const query = parsePaymentHistoryQuery({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
    });

    expect(query.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(query.to?.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('reads a date on its own as midnight UTC of that day, and nothing later', () => {
    // The deliberate anti-smoothing. `to=2026-09-30` does not mean "the end of the 30th", because
    // that would be a hidden `+23:59:59.999` inside a bound somebody is reading off a filter form.
    expect(parsePaymentHistoryQuery({ to: '2026-09-30' }).to?.toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
  });

  it('leaves the other bound null when it was not provided', () => {
    expect(parsePaymentHistoryQuery({ from: '2026-09-01' }).to).toBeNull();
    expect(parsePaymentHistoryQuery({ to: '2026-09-01' }).from).toBeNull();
  });

  it('tolerates surrounding whitespace, which a query string may carry', () => {
    expect(parsePaymentHistoryQuery({ from: '  2026-09-01  ' }).from?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it.each<string>([
    '',
    'yesterday',
    '2026-9-1',
    '01-09-2026',
    '2026-13-01',
    '2026-00-10',
    '2026-02-31',
    '2026-04-31',
    '2026-02-29',
    '2026-09-01T99:00:00Z',
    '1700000000',
  ])('refuses %s', (value) => {
    // Both bounds share one parser, so both are asserted: an empty value (there is no default to
    // fall back on), prose, an unpadded date, day-first, a month that does not exist, a month zero,
    // days a roll-over parser would quietly turn into the next month, the 29th of a February that
    // does not have one, an hour that does not exist, and a unix timestamp - which this API uses
    // nowhere.
    expect(problemFor({ from: value })).toBe('from');
    expect(problemFor({ to: value })).toBe('to');
  });

  it('accepts the 29th of February in a leap year and refuses it in a common one', () => {
    // The pair that makes the calendar check a check rather than a pattern: the same string shape is
    // a real instant in 2028 and a typo in 2026, and only the arithmetic can tell them apart.
    expect(parsePaymentHistoryQuery({ from: '2028-02-29' }).from?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(problemFor({ from: '2026-02-29' })).toBe('from');
  });

  it('allows the two bounds to be equal, because both ends are inclusive', () => {
    const at = '2026-09-01T12:00:00.000Z';

    expect(parsePaymentHistoryQuery({ from: at, to: at }).from?.toISOString()).toBe(at);
  });

  it('refuses an inverted range rather than answering it with an empty page', () => {
    // An empty page for `from > to` reads as "you have no payments", which is a lie about the
    // account rather than about the filter.
    expect(
      problemFor({ from: '2026-09-30T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
    ).toBe('range');
  });

  it('reports the bound that could not be read, not the range it was never part of', () => {
    expect(problemFor({ from: '2026-09-30', to: 'nonsense' })).toBe('to');
    expect(parsePaymentHistoryQuery({ from: '2026-09-30' }).to).toBeNull();
  });
});

describe('limit', () => {
  it('defaults to a page, not to everything', () => {
    expect(parsePaymentHistoryQuery({}).limit).toBe(PAYMENT_HISTORY_DEFAULT_LIMIT);
  });

  it.each<[string, number]>([
    ['1', 1],
    ['20', 20],
    ['50', PAYMENT_HISTORY_MAX_LIMIT],
  ])('accepts %s', (value, expected) => {
    expect(parsePaymentHistoryQuery({ limit: value }).limit).toBe(expected);
  });

  it('clamps above the cap instead of refusing, because here the cap is a cap', () => {
    expect(parsePaymentHistoryQuery({ limit: '51' }).limit).toBe(PAYMENT_HISTORY_MAX_LIMIT);
    expect(parsePaymentHistoryQuery({ limit: '100000' }).limit).toBe(PAYMENT_HISTORY_MAX_LIMIT);
  });

  it('clamps zero up to one rather than answering with an empty page', () => {
    expect(parsePaymentHistoryQuery({ limit: '0' }).limit).toBe(1);
  });

  it('trims, so a padded page size is still a page size', () => {
    expect(parsePaymentHistoryQuery({ limit: ' 7 ' }).limit).toBe(7);
  });

  it.each<string>(['', 'abc', '1.5', '-1', '1e2', '50px', 'NaN', 'twenty'])(
    'refuses %s, which is not a whole number at all',
    (value) => {
      expect(problemFor({ limit: value })).toBe('limit');
    },
  );
});

describe('the scope: membership, never a parameter', () => {
  it('names the caller as the sender for `sent`', () => {
    expect(membershipWhere(USER, 'sent')).toEqual({ senderId: USER });
  });

  it('names the caller as the recipient for `received`', () => {
    expect(membershipWhere(USER, 'received')).toEqual({ recipientId: USER });
  });

  it('is an OR over both columns for `both`, and holds nobody but the caller', () => {
    // The exact shape matters as much as the ids: `GET /v1/payments/:id` builds from this same
    // clause, so a row two other people are party to matches neither branch and is a 404.
    expect(membershipWhere(USER, 'both')).toEqual({
      OR: [{ senderId: USER }, { recipientId: USER }],
    });
  });
});

describe('the WHERE clause a page is read with', () => {
  it('is membership alone when nothing was filtered', () => {
    expect(buildPaymentHistoryWhere(USER, parsePaymentHistoryQuery({}))).toEqual({
      OR: [{ senderId: USER }, { recipientId: USER }],
    });
  });

  it('adds the status as an equality, not as a list', () => {
    expect(buildPaymentHistoryWhere(USER, parsePaymentHistoryQuery({ status: 'FAILED' }))).toEqual({
      OR: [{ senderId: USER }, { recipientId: USER }],
      status: 'FAILED',
    });
  });

  it('adds the window with both bounds inclusive', () => {
    const where = buildPaymentHistoryWhere(
      USER,
      parsePaymentHistoryQuery({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T23:59:59.999Z',
      }),
    );

    expect(where.createdAt).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
      lte: new Date('2026-09-30T23:59:59.999Z'),
    });
  });

  it('adds only the bound that was given', () => {
    expect(
      buildPaymentHistoryWhere(USER, parsePaymentHistoryQuery({ from: '2026-09-01' })).createdAt,
    ).toEqual({ gte: new Date('2026-09-01T00:00:00.000Z') });

    expect(
      buildPaymentHistoryWhere(USER, parsePaymentHistoryQuery({ to: '2026-09-01' })).createdAt,
    ).toEqual({ lte: new Date('2026-09-01T00:00:00.000Z') });
  });

  it('leaves `createdAt` out entirely when neither bound was given', () => {
    expect(buildPaymentHistoryWhere(USER, parsePaymentHistoryQuery({}))).not.toHaveProperty(
      'createdAt',
    );
  });

  it('narrows in one clause per filter, and never replaces the scope', () => {
    const where = buildPaymentHistoryWhere(
      USER,
      parsePaymentHistoryQuery({
        direction: 'received',
        status: 'PROCESSING',
        from: '2026-09-01T00:00:00.000Z',
      }),
    );

    expect(where).toEqual({
      recipientId: USER,
      status: 'PROCESSING',
      createdAt: { gte: new Date('2026-09-01T00:00:00.000Z') },
    });
  });
});

describe('which side of a row the caller is on', () => {
  const sent = { senderId: USER, recipientId: OTHER };
  const received = { senderId: OTHER, recipientId: USER };

  it('reads the row rather than the query, so both parties get their own answer', () => {
    expect(directionFor(sent, USER)).toBe('sent');
    expect(directionFor(received, USER)).toBe('received');
  });

  it('answers `sent` when the caller is somehow on both sides', () => {
    // Impossible today: `assertNotSelf` refuses a self-payment. Asserted so the answer is a
    // decision rather than whichever branch happened to be written first.
    expect(directionFor({ senderId: USER, recipientId: USER }, USER)).toBe('sent');
  });
});

describe('the order a page is read in', () => {
  it('is newest first, with the id as a tiebreak so the order is total', () => {
    expect(PAYMENT_HISTORY_ORDER).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('one page out of `limit + 1` rows', () => {
  it('keeps the page and drops the extra row', () => {
    expect(takePage([1, 2, 3, 4], 3)).toEqual({ items: [1, 2, 3], hasMore: true });
  });

  it('is not `hasMore` when the read came back exactly at the limit', () => {
    // The boundary the whole `+ 1` trick exists for: three rows for a limit of three means the
    // filter has been read to the end, not that a fourth page is waiting.
    expect(takePage([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], hasMore: false });
  });

  it('is not `hasMore` for an empty read', () => {
    expect(takePage([], 3)).toEqual({ items: [], hasMore: false });
  });

  it('works at a limit of one, where every page is a single row', () => {
    expect(takePage([1, 2], 1)).toEqual({ items: [1], hasMore: true });
    expect(takePage([1], 1)).toEqual({ items: [1], hasMore: false });
  });
});

describe('the sentence a refusal becomes', () => {
  const PROBLEMS: readonly HistoryQueryProblem[] = [
    'direction',
    'status',
    'limit',
    'from',
    'to',
    'range',
  ];

  it.each([...PROBLEMS])('names %s rather than saying "invalid query"', (problem) => {
    const message = invalidHistoryQueryMessage(problem);

    expect(message).toContain(problem);
    expect(message.endsWith('.')).toBe(true);
  });

  it('says what the accepted values are wherever there is a short list of them', () => {
    expect(invalidHistoryQueryMessage('direction')).toContain('sent, received, both');
    expect(invalidHistoryQueryMessage('status')).toContain('SUCCESSFUL');
    expect(invalidHistoryQueryMessage('limit')).toContain(String(PAYMENT_HISTORY_MAX_LIMIT));
  });
});

describe('the invariant everything else rests on', () => {
  it('keeps the caller in every clause, for every combination of filters', () => {
    // A property rather than an example: whatever a client sends, the clause this endpoint runs
    // names the caller and nobody else - a filter can narrow that, and nothing can widen it. The
    // inverted range is the one combination that never reaches a query, and it is asserted here
    // rather than skipped, so the property covers the whole product instead of the subset that
    // happens to parse.
    const directions = [undefined, 'sent', 'received', 'both'];
    const statuses = [undefined, 'PENDING', 'SUCCESSFUL'];
    const bounds = [undefined, '2026-09-01', '2026-09-30'];

    let checked = 0;

    for (const direction of directions) {
      for (const status of statuses) {
        for (const from of bounds) {
          for (const to of bounds) {
            if (from === '2026-09-30' && to === '2026-09-01') {
              expect(() => parsePaymentHistoryQuery({ from, to })).toThrow(
                InvalidHistoryQueryError,
              );
              continue;
            }

            const where = buildPaymentHistoryWhere(
              USER,
              parsePaymentHistoryQuery({ direction, status, from, to }),
            );

            expect(JSON.stringify(where)).toContain(USER);
            expect(JSON.stringify(where)).not.toContain(OTHER);
            checked += 1;
          }
        }
      }
    }

    // 4 directions x 3 statuses x 3 bounds x 3 bounds, less the 12 inverted ranges.
    expect(checked).toBe(96);
  });
});

