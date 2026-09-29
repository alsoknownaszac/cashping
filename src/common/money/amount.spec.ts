import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  Amount,
  InvalidAmountError,
  MONEY_DECIMAL_PLACES,
  MONEY_INTEGER_DIGITS,
} from './amount.js';

/**
 * Step 23's first half: the type an amount has to be while the API is handling it,
 * and the two conversions it is allowed to have.
 *
 * The file is argument-shaped, because the rule it supports is an argument. The
 * first block asserts the *failure mode* - the numbers a JS `number` gets wrong -
 * so that the reason this module exists is an executable claim rather than a
 * paragraph someone has to trust. Everything after it is the boundary: what counts
 * as an amount at the wire, what counts as an amount coming back from Postgres, the
 * exact strings both directions produce, and the shape of the rejection message
 * Step 25 will turn into a 400.
 */

/**
 * 7 decimals and 12 integer digits: 19 significant digits, which is more than a
 * double holds (17 at best). Deliberately this side of `numeric(20,7)`, so the same
 * value can be used by `test/money-round-trip.e2e-spec.ts` against Postgres.
 */
const BEYOND_A_DOUBLE = '123456789012.1234567';

/** The message `fromString` refuses `input` with - the whole 400 body, in effect. */
function rejectionFor(input: string): string {
  try {
    Amount.fromString(input);
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error(`fromString accepted ${JSON.stringify(input)}, and it should not have`);
}

describe('the reason this module exists', () => {
  it('cannot be represented by a JS number, and a number would not say so', () => {
    // 123456789012.1234567 rounded to the nearest double. Nothing throws, nothing
    // logs: the 7th decimal is simply gone.
    expect(String(Number(BEYOND_A_DOUBLE))).toBe('123456789012.12346');
    expect(String(Number(BEYOND_A_DOUBLE))).not.toBe(BEYOND_A_DOUBLE);
  });

  it('loses a decimal to arithmetic that looks like it cannot lose one', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(String(0.1 + 0.2)).toBe('0.30000000000000004');
  });

  it('survives exactly, because the value never becomes a number', () => {
    expect(Amount.fromString(BEYOND_A_DOUBLE).toString()).toBe(BEYOND_A_DOUBLE);
    expect(Amount.fromString('0.1').toString()).toBe('0.1');
  });
});

describe('fromString', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    // The value the client sent, and the canonical form it becomes.
    ['0', '0'],
    ['1', '1'],
    ['1.5', '1.5'],
    ['10.0000000', '10'],
    ['0001.5000000', '1.5'],
    ['0.1', '0.1'],
    ['0.0000001', '0.0000001'],
    [BEYOND_A_DOUBLE, BEYOND_A_DOUBLE],
    // Up to the column's own width, and no further: 13 integer digits with all 7
    // decimals spent is the widest value `numeric(20, 7)` can hold, and a type that
    // truncated here instead would be a product decision nobody chose. The bound is the
    // storage layer's, not a per-transaction ceiling - see `MONEY_INTEGER_DIGITS`.
    ['9999999999999.9999999', '9999999999999.9999999'],
  ];

  for (const [input, canonical] of ACCEPTED) {
    it(`accepts ${JSON.stringify(input)} as ${JSON.stringify(canonical)}`, () => {
      expect(Amount.fromString(input).toString()).toBe(canonical);
    });
  }

  it('collapses every accepted spelling of one amount onto one string', () => {
    const spellings = ['1.5', '1.50', '01.5', '1.5000000', '0001.5000000'];

    expect(new Set(spellings.map((spelling) => Amount.fromString(spelling).toString())).size).toBe(
      1,
    );
  });

  // The second column is the exact reason the rejection carries, not a fragment:
  // `describeRejection` builds the message the 400 will use, so the table is the
  // wire contract for a malformed amount.
  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ['', 'nothing was submitted'],
    ['   ', 'nothing was submitted'],
    [' 1', 'leading or trailing whitespace'],
    ['1 ', 'leading or trailing whitespace'],
    ['1 000', 'whitespace inside the number'],
    ['+1', 'a sign, and an amount is written without one'],
    ['-1', 'a sign, and an amount is written without one'],
    ['1e3', 'exponent notation, which is how a float writes a decimal'],
    ['1E3', 'exponent notation, which is how a float writes a decimal'],
    ['1e-7', 'exponent notation, which is how a float writes a decimal'],
    ['.5', 'a leading decimal point, which needs a zero in front of it'],
    ['1.', 'a trailing decimal point'],
    ['1,000', 'a thousands separator'],
    ['1.23456789', `8 decimal places, and an amount has at most ${MONEY_DECIMAL_PLACES}`],
    ['abc', 'not plain digits with an optional decimal point'],
    ['NaN', 'not plain digits with an optional decimal point'],
    ['Infinity', 'not plain digits with an optional decimal point'],
    ['0x10', 'not plain digits with an optional decimal point'],
    // Two points: the reason must be about the shape, not about the `0` after the
    // last point, which is what a naive decimal-count would have reported.
    ['1.0.0', 'not plain digits with an optional decimal point'],
    // Unicode digits are not `\d`, and a client that sends them is a client whose
    // formatter this API cannot reason about.
    ['١٢٣', 'not plain digits with an optional decimal point'],
  ];

  for (const [input, detail] of REJECTED) {
    it(`rejects ${JSON.stringify(input)} with ${JSON.stringify(detail)}`, () => {
      expect(() => Amount.fromString(input)).toThrowError(new InvalidAmountError(input, detail));
    });
  }

  it('carries the rejected input on the error, so the 400 can name it', () => {
    try {
      Amount.fromString('$5');
      expect.unreachable('fromString accepted a currency symbol');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAmountError);
      expect((error as InvalidAmountError).input).toBe('$5');
    }
  });

  it('allows exactly MONEY_DECIMAL_PLACES decimals, and not one more', () => {
    const atTheLimit = `1.${'1'.repeat(MONEY_DECIMAL_PLACES)}`;

    expect(Amount.fromString(atTheLimit).toString()).toBe(atTheLimit);
    expect(rejectionFor(`${atTheLimit}0`)).toContain(`${MONEY_DECIMAL_PLACES + 1} decimal places`);
  });

  it('allows exactly MONEY_INTEGER_DIGITS integer digits, and not one more', () => {
    // The column's width, and the one bound that is not a product decision: a wider
    // value is refused by Postgres with `numeric field overflow`, which would reach a
    // client as a 500 for a bad request. The end of the range is accepted with all
    // seven decimals spent, so the check cannot be a truncation in disguise.
    const widest = `${'9'.repeat(MONEY_INTEGER_DIGITS)}.${'9'.repeat(MONEY_DECIMAL_PLACES)}`;

    expect(Amount.fromString(widest).toString()).toBe(widest);
    expect(rejectionFor(`1${'0'.repeat(MONEY_INTEGER_DIGITS)}`)).toContain(
      `${MONEY_INTEGER_DIGITS + 1} integer digits`,
    );
    // Padding is not width: this is `1.5`, and it is accepted as such.
    expect(Amount.fromString('0001.50').toString()).toBe('1.5');
  });

  it('writes the smallest unit as a decimal, not as an exponent', () => {
    // decimal.js's own `toString()` switches to exponential notation below 1e-7,
    // which is why `Amount#toString()` is built on `toFixed()`. Asserted against
    // decimal.js itself so the reason for that choice stays checkable.
    expect(new Decimal('0.0000001').toString()).toBe('1e-7');
    expect(Amount.fromString('0.0000001').toString()).toBe('0.0000001');
  });
});

describe('toStellarAmount', () => {
  it('writes an amount the way the ledger does: always MONEY_DECIMAL_PLACES decimals', () => {
    expect(Amount.fromString('1').toStellarAmount()).toBe('1.0000000');
    expect(Amount.fromString('0.1').toStellarAmount()).toBe('0.1000000');
    expect(Amount.fromString(BEYOND_A_DOUBLE).toStellarAmount()).toBe(BEYOND_A_DOUBLE);
  });

  it('pads rather than rounds, so no value is ever altered on the way to the network', () => {
    // The only amount whose 7-decimal form could plausibly be a rounding decision is
    // the smallest one, and the two forms are the same string.
    const smallestUnit = Amount.fromString('0.0000001');

    expect(smallestUnit.toStellarAmount()).toBe('0.0000001');
    expect(smallestUnit.toStellarAmount()).toBe(smallestUnit.toString());
  });

  it('agrees with MONEY_DECIMAL_PLACES instead of hard-coding a second 7', () => {
    for (const value of ['0', '1.5', BEYOND_A_DOUBLE]) {
      expect(Amount.fromString(value).toStellarAmount()).toMatch(
        new RegExp(`^\\d+\\.\\d{${MONEY_DECIMAL_PLACES}}$`),
      );
    }
  });
});

describe('fromDatabase', () => {
  it('accepts what Prisma hands back for a numeric column, padding and all', () => {
    // Postgres returns numeric(20,7) with every one of its decimals, so a stored
    // `1.5` arrives as `1.5000000` and has to come out canonical.
    expect(Amount.fromDatabase('1.5000000').toString()).toBe('1.5');
    expect(Amount.fromDatabase('0.0000001').toString()).toBe('0.0000001');
    expect(Amount.fromDatabase(BEYOND_A_DOUBLE).toString()).toBe(BEYOND_A_DOUBLE);
  });

  it('accepts a Decimal-like object, which is what Prisma 7 actually returns', () => {
    const prismaDecimal = { toString: (): string => '1.5000000' };

    expect(Amount.fromDatabase(prismaDecimal).toString()).toBe('1.5');
  });

  it('accepts exponential notation, because that is how Decimal#toString writes 1e-7', () => {
    // Not a relaxation for its own sake: `new Decimal('0.0000001').toString()` is
    // `1e-7`, so a stored smallest unit reaches this method in exactly this shape
    // (asserted in the `fromString` block above).
    expect(Amount.fromDatabase('1e-7').toString()).toBe('0.0000001');
  });

  it('refuses a value with more decimals than the column can hold', () => {
    // The check that earns this method. A JS float that reached the database - or a
    // column typed `double precision` somewhere - reads back with 15-17 decimal
    // places instead of failing.
    expect(() => Amount.fromDatabase(String(0.1 + 0.2))).toThrowError(
      new InvalidAmountError(
        '0.30000000000000004',
        '17 decimal places, and a stored amount has at most 7 - a value that went through a JS number looks like this',
      ),
    );
    expect(() => Amount.fromDatabase('0.12345678')).toThrowError(/8 decimal places/);
  });

  it('cannot undo a loss that already happened, which is why the column type is the other half', () => {
    // Honest about the limit of the check: this value went through a double and lost
    // its 7th decimal, and what survives is an exact 5-decimal number. Nothing at
    // this layer can tell it from a legitimate 5-decimal amount - so the defence is
    // the column (`numeric`, never `float`), enforced by `amount-discipline.ts`.
    expect(String(Number(BEYOND_A_DOUBLE))).toBe('123456789012.12346');
    expect(Amount.fromDatabase(String(Number(BEYOND_A_DOUBLE))).toString()).toBe(
      '123456789012.12346',
    );
  });

  it('rejects a negative stored amount, and accepts a negative-looking comparison only after parsing', () => {
    expect(() => Amount.fromDatabase('-1.5000000')).toThrowError(/a negative amount/);
  });

  it('rejects what is not a numeric value at all', () => {
    for (const value of ['abc', 'NaN', 'Infinity', '', '0x10']) {
      expect(() => Amount.fromDatabase(value)).toThrowError(InvalidAmountError);
    }
  });
});

describe('isPositive', () => {
  it('is false for zero in every spelling, and true for the smallest unit', () => {
    expect(Amount.fromString('0').isPositive()).toBe(false);
    expect(Amount.fromString('0.0000000').isPositive()).toBe(false);
    expect(Amount.fromString('0.0000001').isPositive()).toBe(true);
    expect(Amount.fromString('1').isPositive()).toBe(true);
  });

  it('is not decimal.js own isPositive, which is true for zero', () => {
    // The trap this method was written twice over: `isPositive` and `isPos` are the
    // same function in decimal.js 10 (`this.s > 0`), and `'0'` parses with sign `1`.
    // Asserted against decimal.js directly so the reason for `greaterThan(0)` stays
    // checkable, and so the next person to "simplify" it sees what happens.
    expect(new Decimal('0').isPositive()).toBe(true);
    expect(new Decimal('0').isPos()).toBe(true);
    expect(new Decimal('0').greaterThan(0)).toBe(false);
    expect(Amount.fromString('0').isPositive()).toBe(false);
  });
});

describe('minus', () => {
  it('is exact for the ordinary case a float gets wrong', () => {
    expect(0.3 - 0.2).not.toBe(0.1);
    expect(Amount.fromString('0.3').minus(Amount.fromString('0.2')).toString()).toBe('0.1');
    expect(Amount.fromString('1.0000000').minus(Amount.fromString('0.0000001')).toString()).toBe(
      '0.9999999',
    );
  });

  it('removes exactly the amount that was there, down to zero', () => {
    const balance = Amount.fromString(BEYOND_A_DOUBLE);

    expect(balance.minus(balance).toString()).toBe('0');
    expect(balance.minus(Amount.fromString('0')).toString()).toBe(BEYOND_A_DOUBLE);
    expect(balance.minus(Amount.fromString('0.0000001')).toString()).toBe('123456789012.1234566');
  });

  it('keeps 21 significant digits, which the library default would round away', () => {
    // The widest result two `Amount`s can produce. It is not a payment this API can
    // send (no column error, no client input) - it is the measurement that shows why
    // MONEY_ARITHMETIC_PRECISION is not decimal.js's default of 20. A client's whole
    // complaint about money bugs is "the number changed and nothing said so", so the
    // default is asserted to *be* wrong here, next to the value this class produces.
    const largest = Amount.fromString('9999999999999.9999999');
    const doubled = '19999999999999.9999998';

    expect(new Decimal('9999999999999.9999999').plus('9999999999999.9999999').toString()).not.toBe(
      doubled,
    );

    // The same magnitude through this class, as `largest - (0 - largest)`: the
    // subtraction can leave the range the column stores (see the next test), which is
    // how the sum is reachable at all without a `plus`.
    expect(largest.minus(Amount.fromString('0').minus(largest)).toString()).toBe(doubled);
  });

  it('can go negative, unlike the two factories, because an over-committed balance is real', () => {
    // `fromString` refuses `-0.5` and `fromDatabase` refuses `-1.5000000`: a negative
    // amount is not something a client may send or a column may store. A negative
    // *result* is the state the overdraft check exists to detect, so it must be
    // representable - and it must not throw on the way, or a raced payment would turn
    // into a 500 instead of a refusal.
    const debt = Amount.fromString('1').minus(Amount.fromString('1.5'));

    expect(debt.toString()).toBe('-0.5');
    expect(Amount.fromString('1').minus(Amount.fromString('2.5')).toString()).toBe('-1.5');
  });
});

describe('isAtLeast', () => {
  it('accepts spending exactly the balance, and one unit above it', () => {
    const balance = Amount.fromString('10.0000000');

    expect(balance.isAtLeast(Amount.fromString('10'))).toBe(true);
    expect(balance.isAtLeast(Amount.fromString('9.9999999'))).toBe(true);
  });

  it('refuses one unit more, and a zero balance against a real payment', () => {
    const balance = Amount.fromString('10.0000000');

    expect(balance.isAtLeast(Amount.fromString('10.0000001'))).toBe(false);
    expect(Amount.fromString('0').isAtLeast(Amount.fromString('0.0000001'))).toBe(false);
    // Zero against zero is fine - nothing to spend is not an overdraft.
    expect(Amount.fromString('0').isAtLeast(Amount.fromString('0.0000000'))).toBe(true);
  });

  it('compares by value, so two spellings of one amount agree', () => {
    expect(Amount.fromString('1.50').isAtLeast(Amount.fromString('1.5'))).toBe(true);
    expect(Amount.fromString('1.5').isAtLeast(Amount.fromString('1.50'))).toBe(true);
    expect(Amount.fromString('007').isAtLeast(Amount.fromString('7.0'))).toBe(true);
  });

  it('cannot pass on a negative balance, however small the payment', () => {
    // The whole point of the pair: `minus` may go below zero, and the comparison is
    // what turns that into a refusal rather than a payment.
    const overdrawn = Amount.fromString('1').minus(Amount.fromString('2'));

    expect(overdrawn.isAtLeast(Amount.fromString('0'))).toBe(false);
    expect(overdrawn.isAtLeast(Amount.fromString('0.0000001'))).toBe(false);
  });
});

describe('toJSON', () => {
  it('serializes as the string, not as decimal.js internals', () => {
    expect(JSON.stringify({ amount: Amount.fromString('1.50') })).toBe('{"amount":"1.5"}');
    expect(JSON.stringify([Amount.fromString(BEYOND_A_DOUBLE)])).toBe(`["${BEYOND_A_DOUBLE}"]`);
  });
});
