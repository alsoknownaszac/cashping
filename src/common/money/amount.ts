import { Decimal } from 'decimal.js';

/**
 * How much money, as a value that cannot quietly lose a digit.
 *
 * Step 23, and the foundation Day 4 is built on. The rule this file makes
 * mechanical is the one the build sequence states as a convention: **an amount is
 * a string in every DTO and every JSON response - converted to a `Decimal`
 * immediately on entry, and back to a string immediately on exit, with no bare JS
 * `number` in between.**
 *
 * The rule is not caution for its own sake. A JS `number` is a binary
 * floating-point value and the money this API moves is 7-decimal fixed point,
 * which a binary fraction cannot hold. `0.1 + 0.2` is `0.30000000000000004`, and
 * `Number('123456789012.1234567')` is `123456789012.12346` - the 7th decimal is
 * gone on the way in, silently, from a single expression that looks harmless.
 * That is the shape of every money bug: nothing throws, nothing logs, and the
 * conversation happens a week later, with a support ticket and a reconciliation
 * break. `amount.spec.ts` asserts both of those numbers, so this file's reason for
 * existing is executable rather than argued in prose.
 *
 * ## Why `Decimal` rather than integer minor units
 *
 * Stroops (1e-7) are the other standard answer, and they are exact too. They are
 * not used here because every boundary this API already has *is* a decimal string:
 * Horizon reports balances as 7-decimal strings, the Stellar SDK is handed an
 * amount as a 7-decimal string, Postgres stores `numeric`, and JSON cannot carry a
 * 64-bit integer without a client having to guess. Minor units would mean a
 * conversion at each of those four boundaries - four places to get it wrong - in
 * exchange for arithmetic that `decimal.js` already does exactly.
 * `toStellarAmount()` below is the one conversion *towards* minor units, and it
 * happens in one place.
 *
 * ## The arithmetic that *is* here, and why it is one operation wide
 *
 * Step 23 left arithmetic out on purpose, with a promise attached: the first code
 * that needed it would add the operation *and* the precision decision together,
 * where a reviewer can see both. Step 25 is that code - the overdraft check has to
 * ask "is the sender's balance at least this payment plus everything already in
 * flight for them?", and that needs exactly one subtraction and one comparison.
 * Both are here now, and `MONEY_ARITHMETIC_PRECISION` below is the decision.
 *
 * What is still absent is every other operation. There is no `plus`, no `times`,
 * no percentage and no allocation: a fee or a split would each need their own
 * rounding rule (what happens to the half-stroop), and inventing them before there
 * is a product reason would bake in a policy nobody chose. The comparison arrives
 * with the subtraction because a number you cannot compare cannot be checked, and
 * comparison needs no precision at all - `decimal.js` compares exactly.
 *
 * The other thing not here is a maximum. The per-transaction ceiling was left with
 * Step 25 as "its product rule", and Step 25 deliberately did not add one: no
 * product limit is specified anywhere, so the only ceiling is the column's own
 * `numeric(20, 7)` (thirteen integer digits), applied by Postgres. Putting a guess
 * at a limit inside the type every money path has to use would hide a product
 * decision in the one place nobody looks for it.
 */

/**
 * Stellar's fixed point: every asset on the network has exactly this many decimal
 * places, so it is a property of the ledger rather than a deployment setting.
 * Making it configurable would only allow a configuration that cannot talk to the
 * network it is running on.
 */
export const MONEY_DECIMAL_PLACES = 7;

/**
 * Integer digits a stored amount has room for, from the column's own width.
 *
 * `Decimal @db.Decimal(20, 7)` - the type the money rule prescribes and the one
 * `Transaction.amount` uses - is 20 digits of precision with 7 after the point, so
 * 13 lie in front of it. `fromString` refuses text wider than that, and the reason
 * is not tidiness: Postgres raises `numeric field overflow` for a wider value, which
 * reaches a client as a 500 for what is really a bad request. A ceiling the storage
 * layer enforces has to be answered where the amount is parsed, or the client is
 * blamed for the database's limit. It is *not* a product ceiling - a per-transaction
 * maximum would be a decision nobody has made (see the module docblock).
 */
export const MONEY_INTEGER_DIGITS = 13;

/**
 * The precision money arithmetic is done at (Step 25).
 *
 * `decimal.js`'s default is 20 significant digits, and 20 is *not* enough for
 * money - which is worth spelling out, because it looks like plenty. A
 * `numeric(20, 7)` value is 13 integer digits plus 7 decimals, so a single operand
 * is at most 20 significant digits; a result can be wider, because the integer part
 * grows and the decimals stay (`9999999999999.9999999 + 9999999999999.9999999` is
 * `19999999999999.9999998` - 21 significant digits), and at the default precision
 * that last digit is *rounded*, silently. 40 leaves room for any combination of
 * operands a `numeric(20, 7)` column can hold (and for a fee rule later), so no
 * operation this API can express rounds at all. `amount.spec.ts` asserts the 21-digit
 * case against both constructors, so the difference is executable rather than argued.
 *
 * The rounding mode is therefore unreachable, and it is stated rather than left at
 * the library default for one reason: the first *reachable* rounding should be a
 * decision someone made, not something inherited. Half-up matches what Postgres
 * does with `numeric` (it rounds half away from zero), so an amount that ever does
 * get rounded here rounds the way the column would.
 */
export const MONEY_ARITHMETIC_PRECISION = 40;

/**
 * `decimal.js` at the precision above, as a *clone* rather than `Decimal.set(...)`.
 *
 * `Decimal.set` is global: it would reconfigure the constructor the whole process
 * shares, including the one `fromString` parses with (where rounding cannot happen
 * and must never be introduced) and any future library that computes with decimals.
 * A clone has its own config, so this module configures arithmetic and nothing else.
 * The clone is deliberately not exported: arithmetic has one home, and it is the
 * methods below.
 */
const Money = Decimal.clone({
  precision: MONEY_ARITHMETIC_PRECISION,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * The only text this API accepts as an amount.
 *
 * Plain digits, one optional point, at most `MONEY_DECIMAL_PLACES` decimals - and
 * nothing else, which is the part that matters. No sign (a negative amount is a
 * different operation, not a smaller payment), no exponent (`1e-7` is how a
 * *float* writes the smallest unit; accepting it would mean accepting whatever a
 * client's number formatter produced), no thousands separators, no whitespace, no
 * Unicode digits, no `NaN`/`Infinity`, no hex. Rejecting the exotic spellings is
 * not pedantry: every accepted spelling is a spelling the rest of the pipeline has
 * to carry exactly, and the canonical form at the bottom of this class is what
 * makes two spellings of one amount compare equal.
 *
 * `7` is `MONEY_DECIMAL_PLACES` written out, because a pattern assembled from an
 * interpolated constant cannot be read. `amount.spec.ts` asserts that the two
 * agree, so they cannot drift apart unnoticed.
 */
const AMOUNT_TEXT = /^\d+(\.\d{1,7})?$/;

/**
 * What a decimal value read back from the database may look like.
 *
 * Deliberately looser than `AMOUNT_TEXT`: `decimal.js` and Postgres format for
 * themselves, and `Decimal#toString()` switches to exponential notation below
 * `1e-7`, so a stored `0.0000001` legitimately arrives as `1e-7`. What is *not*
 * allowed is anything that is not a decimal number at all (`0x10` is 16 to
 * `decimal.js`, and no `numeric` column can hold it), so the accepted shapes are an
 * optional sign, digits with an optional point, and an optional exponent. A sign is
 * allowed here so that the negative check below gets to explain itself, instead of a
 * negative amount being refused as unparseable.
 */
const DATABASE_VALUE_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Thrown when text cannot be turned into an amount.
 *
 * Deliberately *not* an `HttpException`, following `InvalidPhoneNumberError`: this
 * is a money-level fact, and the type is used from places that are not HTTP
 * requests. The payment endpoint maps it onto a 400 at the edge (Step 25), so
 * there is still exactly one place that decides what a malformed amount looks like
 * over the wire.
 */
export class InvalidAmountError extends Error {
  constructor(
    /** The value as it arrived, so the caller can say which input was rejected. */
    readonly input: string,
    detail?: string,
  ) {
    super(
      detail === undefined
        ? `"${input}" is not an amount`
        : `"${input}" is not an amount (${detail})`,
    );
    this.name = 'InvalidAmountError';
  }
}

/**
 * Why a piece of text was rejected, in the words the 400 will use.
 *
 * The reason is worth the ten lines: `"1.23456789" is not an amount (8 decimal
 * places, and an amount has at most 7)` tells a developer what to fix, where
 * "invalid amount" starts an afternoon of guessing - and the decimal-places
 * message is the one that matters, because a client sending 8 decimals is usually
 * a client formatting with a float.
 *
 * Ordered most specific first. The fallback names what *is* accepted.
 */
function describeRejection(input: string): string {
  if (/^[+-]/.test(input)) {
    return 'a sign, and an amount is written without one';
  }

  if (/[eE]/.test(input)) {
    return 'exponent notation, which is how a float writes a decimal';
  }

  if (/^\d+\.$/.test(input)) {
    return 'a trailing decimal point';
  }

  if (input.startsWith('.')) {
    return 'a leading decimal point, which needs a zero in front of it';
  }

  if (/\s/.test(input)) {
    return 'whitespace inside the number';
  }

  if (/,\d/.test(input)) {
    return 'a thousands separator';
  }

  // Only when the input is digits and *one* point: `1.0.0` ends in `.0`, and
  // reporting "1 decimal places" for it would send the reader after the wrong
  // problem.
  const decimalPlaces = /^\d+\.(\d+)$/.exec(input)?.[1];

  if (decimalPlaces !== undefined) {
    return `${decimalPlaces.length} decimal places, and an amount has at most ${MONEY_DECIMAL_PLACES}`;
  }

  return 'not plain digits with an optional decimal point';
}

/**
 * An amount of money.
 *
 * Constructed only through `fromString` (untrusted text) or `fromDatabase` (a
 * value Postgres returned), so an instance cannot exist without having been
 * validated once. The constructor is private for that reason: `new Amount(x)` in a
 * controller is not a mistake anyone can make.
 */
export class Amount {
  private constructor(private readonly value: Decimal) {}

  /**
   * Parse an amount a client sent - the one entry point for untrusted text.
   *
   * Strict about the *text*, not the parsed value, and that is on purpose: `0001.50`
   * and `1.5` are the same amount and both are accepted, while `1.50000000` (eight
   * decimals), `-1`, `1e3` and `" 1 "` are rejected with a reason. The asymmetry
   * with `fromDatabase` is the design: text from outside is judged by its spelling,
   * because the client is the thing that might be wrong; text from Postgres is
   * judged by its value, because `numeric` is not creative about formatting.
   *
   * Throws `InvalidAmountError`; the caller decides what that means (Step 25 maps
   * it to a 400).
   */
  static fromString(input: string): Amount {
    if (input.trim() === '') {
      throw new InvalidAmountError(input, 'nothing was submitted');
    }

    if (input !== input.trim()) {
      throw new InvalidAmountError(input, 'leading or trailing whitespace');
    }

    if (!AMOUNT_TEXT.test(input)) {
      throw new InvalidAmountError(input, describeRejection(input));
    }

    /**
     * Padding zeros are not width: `0001.50` is `1.5` and has one integer digit.
     * Leading zeros are stripped rather than counted, so the check is about the value
     * the column will hold.
     */
    const integerDigits = (input.split('.')[0] ?? '').replace(/^0+/, '').length;

    if (integerDigits > MONEY_INTEGER_DIGITS) {
      throw new InvalidAmountError(
        input,
        `${integerDigits} integer digits, and a stored amount has room for ${MONEY_INTEGER_DIGITS} - see MONEY_INTEGER_DIGITS`,
      );
    }

    return new Amount(new Decimal(input));
  }

  /**
   * Read an amount the database returned.
   *
   * Accepts whatever Prisma hands back for a `numeric` column - its own `Decimal`,
   * or a string - and is typed structurally (`toString`) rather than against the
   * generated client, so `common/money` stays a leaf module that survives a Prisma
   * regeneration untouched.
   *
   * Judged by *value*: a stored `0.0000001` comes back from `Decimal#toString()` as
   * `1e-7`, which is exact and allowed here, and `toString()` below writes it back
   * as `0.0000001`. What is not allowed is a value that could not have come from a
   * 7-decimal column, and that check is what earns this method: a JS float that
   * reached the database - or a column typed `double precision` somewhere - reads
   * back with 15-17 decimal places, and this throws instead of quietly serving a
   * balance with `0000000000000004` on the end.
   */
  static fromDatabase(value: string | { toString(): string }): Amount {
    const text = typeof value === 'string' ? value : value.toString();
    const normalised = text.trim();

    if (!DATABASE_VALUE_TEXT.test(normalised)) {
      throw new InvalidAmountError(text, 'not a value a numeric column could have returned');
    }

    const parsed = new Decimal(normalised);

    if (!parsed.isFinite()) {
      throw new InvalidAmountError(text, 'not a finite value');
    }

    if (parsed.isNegative()) {
      throw new InvalidAmountError(text, 'a negative amount, which this schema does not store');
    }

    if (parsed.decimalPlaces() > MONEY_DECIMAL_PLACES) {
      throw new InvalidAmountError(
        text,
        `${parsed.decimalPlaces()} decimal places, and a stored amount has at most ${MONEY_DECIMAL_PLACES} - a value that went through a JS number looks like this`,
      );
    }

    return new Amount(parsed);
  }

  /**
   * The exact value, as the string that goes into the database and the string that
   * goes into JSON.
   *
   * One form, deliberately, rather than a "storage form" and a "response form": an
   * amount cannot be right in the database and wrong in the response if there is
   * only one of it. Prisma parses this string into its own `Decimal` exactly on the
   * way to a `numeric` column, so no float is involved on that side either.
   *
   * `toFixed()` rather than `toString()`: `toString()` switches to exponential
   * notation below `1e-7` (`0.0000001` would serialize as `1e-7`), and this is what
   * makes the canonical form the *shortest exact* one - `1.5000000` is written
   * `1.5`, `10.0000000` is written `10`. A client that wants to show `1.50` formats
   * for display; presentation is not part of the value.
   */
  toString(): string {
    return this.value.toFixed();
  }

  /**
   * The same amount the way the ledger writes it: always `MONEY_DECIMAL_PLACES`
   * decimals, trailing zeros included, so `1` is `1.0000000`.
   *
   * This is the form Day 4 hands to the Stellar SDK and the form Horizon answers
   * account lines with. It exists now rather than then because the format is the
   * ledger's - there is nothing left to decide about it - and because the smallest
   * unit this API can move (`0.0000001`) is the reason `MONEY_DECIMAL_PLACES` is 7
   * instead of a guess.
   */
  toStellarAmount(): string {
    return this.value.toFixed(MONEY_DECIMAL_PLACES);
  }

  /**
   * Whether this is more than zero.
   *
   * Here so that Step 25 can validate a payment amount without writing
   * `Number(amount) > 0` - the same mistake as storing the amount as a number, one
   * comparison long. "Zero is not a payment" is the caller's rule; this is only the
   * question.
   *
   * `greaterThan(0)`, and deliberately not decimal.js's own `isPositive()`: in
   * decimal.js 10, `isPositive` and `isPos` are the same function - `this.s > 0` -
   * so both are **true for `0`**, and only `-0` and negatives are false (`'0'`
   * parses with sign `1`). `amount.spec.ts` pins `0`, `0.0000000` and `0.0000001`
   * separately because of it: the version of this method first written against
   * `isPos()` let a zero amount through, which is exactly the bug a Step 25
   * "amount must be positive" check would have inherited.
   */
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  /**
   * This amount less `other` - exact, and the one arithmetic operation this API
   * has (Step 25).
   *
   * Written for the overdraft check, which has to turn "what the wallet holds" and
   * "what is already committed against it" into the number a payment is measured
   * against; see `MONEY_ARITHMETIC_PRECISION` for the precision this is computed
   * at, and why it is not the library default. The result is *not* re-validated:
   * `fromString` and `fromDatabase` both refuse a negative amount because a
   * negative amount is not something a client may send or a column may store, but a
   * negative *result* is a real and important state - it is what an over-committed
   * wallet looks like, and the caller's job is to compare it (see `isAtLeast`),
   * never to skip the subtraction and assume it cannot go below zero.
   */
  minus(other: Amount): Amount {
    return new Amount(Money.sub(this.value, other.value));
  }

  /**
   * Whether this amount is at least `other`.
   *
   * A comparison, not arithmetic: `decimal.js` compares exactly at any precision,
   * so there is no rounding policy hiding here, and `>=` is deliberate rather than
   * `>` - spending exactly the balance down to zero is a legal payment, which is
   * the distinction `isPositive`'s docblock flags for the other end of the range.
   *
   * Takes an `Amount`, never a string or a number: comparing money is only
   * meaningful between two values that have both been through this class.
   */
  isAtLeast(other: Amount): boolean {
    return this.value.greaterThanOrEqualTo(other.value);
  }

  /**
   * Serialization is the string, always.
   *
   * `JSON.stringify` would otherwise reach for the private `Decimal` and emit
   * decimal.js's internal shape (`{ s, e, d }`), which is not an amount any client
   * can use. The DTO types should make this unreachable - a response field is typed
   * `string` - and this is what happens if an `Amount` reaches a payload anyway.
   */
  toJSON(): string {
    return this.toString();
  }
}
