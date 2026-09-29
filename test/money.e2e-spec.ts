import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Amount, InvalidAmountError, MONEY_DECIMAL_PLACES } from './../src/common/money/amount.js';
import configuration from './../src/config/configuration.js';
import { validate } from './../src/config/validation.schema.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

/**
 * Step 23 against the real database: a deliberately-crafted high-precision amount
 * round-trips through create -> store -> display without precision loss.
 *
 * That sentence is the Day 3 audit checklist's own wording for this step, and the reason
 * it belongs in a *database* test is its middle word. `Amount` and `amount.spec.ts`
 * already pin the two conversions in memory; what no unit test can show is that the third
 * of the three - the column - does not quietly eat a digit on the way through. A `double
 * precision` column does, and this file makes one do it deliberately, in the row next to
 * the column the codebase prescribes.
 *
 * ## Where this file's "create" and "display" stop
 *
 * The full sentence is the product's: a client posts an amount, a row is written, a
 * balance screen shows the same digits. Two of those three hops do not exist yet - the
 * `POST /v1/payments` endpoint and the `Transaction` model are Step 25, and Step 23 is the
 * step that decides the rules they are written under. So this file proves the half that is
 * already real, on a table it creates for the purpose, and names the hops as it goes:
 *
 *     create   `Amount.fromString` - the one entry point untrusted text has
 *     store    `numeric(20, 7)` - the column `money-discipline.ts` prescribes
 *     display  `Amount.fromDatabase(...).toString()`, and the JSON body around it
 *
 * ...and then the counter-example the rule exists for: the same crafted value written to a
 * `double precision` column, read back changed.
 *
 * ## Running it
 *
 * Local-only, like the other e2e files: it needs the compose stack (`docker compose up -d
 * postgres redis`) and a `.env` whose `DATABASE_URL` points at it. `ConfigModule.forRoot`
 * loads `.env` exactly as `main.ts` does, so nothing has to be exported on the command
 * line. It is not part of CI. `npm run test:e2e test/money.e2e-spec.ts`.
 *
 * ## What it leaves behind
 *
 * Nothing of its own: the probe table is dropped in `afterAll`. The probe exists because this
 * file needs two column types side by side - the prescribed one and a float - and no real table
 * offers both. Since Step 25 there *is* a money column in the schema
 * (`transactions.amount`, `Decimal @db.Decimal(20, 7)`), and the `describe` at the end reads it
 * out of `information_schema` as well: the prescribed type is now also asserted where it is
 * actually used, not only on a table this file made.
 */

/** The probe table, dropped in `afterAll` whatever happens above. */
const PROBE_TABLE = 'money_round_trip_probe';

/** The one row each test writes and reads back. */
const PROBE_ID = 1;

/**
 * The crafted amount: twelve integer digits, and all seven decimals.
 *
 * Chosen because it is provably beyond a JS number - `Number(CRAFTED)` differs from the
 * literal, which is asserted below rather than trusted - and because the thirteen-digit
 * ceiling of `numeric(20, 7)` leaves room for it. `0.0000001`, the smallest unit this API
 * moves, and a plain `1` ride along: the canonical form has to survive the same trip at
 * both ends of the range (Prisma's `Decimal` writes `0.0000001` as `1e-7`, and the column
 * stores `1` as `1.0000000`).
 */
const CRAFTED = '123456789012.1234567';
const ROUND_TRIP_CASES = [CRAFTED, '0.0000001', '1', '9999999999999.9999999'] as const;

/**
 * What the database handed back, in the shapes Prisma returns.
 *
 * A `numeric` column comes back as Prisma's own `Decimal`, which is exactly what
 * `Amount.fromDatabase` accepts structurally - the interface says the same thing the
 * method's parameter does, and `'reports the shapes it read'` below fails if either
 * drifts. A `double precision` column comes back as a JS number, which is the point of
 * having one in this table at all.
 */
interface ProbeRow {
  readonly exact_amount: string | { toString(): string };
  readonly float_amount: number;
}

let prisma: PrismaService;

/**
 * The real `PrismaService`, assembled the way `app.module.ts` assembles it.
 *
 * `ConfigModule.forRoot` with the app's own factory and validation schema, rather than a
 * `ConfigService` stubbed over `process.env`: the value under test has to be the
 * `DATABASE_URL` the application reads, and a missing one should fail here with the app's
 * own message. Nothing else from `AppModule` comes along - no Redis, no KMS, no HTTP - so
 * a failure inside this file is a database failure.
 */
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, cache: true, load: [configuration], validate }),
    ],
  }).compile();
  const config = moduleRef.get(ConfigService);

  prisma = new PrismaService(config);

  // Recreated rather than reused: a previous run that died mid-test would otherwise leave
  // a table whose columns this file did not build.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`);
  await prisma.$executeRawUnsafe(
    [
      `CREATE TABLE "${PROBE_TABLE}" (`,
      '  "id" integer PRIMARY KEY,',
      '  "exact_amount" numeric(20, 7) NOT NULL,',
      '  "float_amount" double precision NOT NULL',
      ')',
    ].join('\n'),
  );
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`);
  await prisma.$disconnect();
});

/**
 * Raw SQL with `$1`-style placeholders, the way the codebase's one other raw statement
 * does it (`auth.e2e-spec.ts`): the spelling of the SQL stays visible in the source.
 *
 * The `...Unsafe` name is about the statement's *text*, not its parameters - and in two
 * tests below that is precisely the point. `0.1::float8 + 0.2::float8` and an
 * eight-decimal literal are values the application cannot produce, because
 * `Amount.fromString` refuses both spellings; writing them as SQL literals is how a float
 * column gets fed the thing the money rule forbids. Every value that *does* come from the
 * application is bound as `$1` and never interpolated.
 */
async function store(text: string): Promise<ProbeRow> {
  await prisma.$executeRawUnsafe(
    [
      `INSERT INTO "${PROBE_TABLE}" ("id", "exact_amount", "float_amount")`,
      'VALUES ($1, $2::numeric(20, 7), $2::double precision)',
      'ON CONFLICT ("id") DO UPDATE SET',
      '  "exact_amount" = EXCLUDED."exact_amount",',
      '  "float_amount" = EXCLUDED."float_amount"',
    ].join('\n'),
    PROBE_ID,
    text,
  );

  return read();
}

/** The row, read back through the generated client, or a failure that names the gap. */
async function read(): Promise<ProbeRow> {
  const rows = await prisma.$queryRawUnsafe<ProbeRow[]>(
    `SELECT "exact_amount", "float_amount" FROM "${PROBE_TABLE}" WHERE "id" = $1`,
    PROBE_ID,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`no row in ${PROBE_TABLE} for id ${PROBE_ID}`);
  }

  return row;
}

/** The display half of the round trip: the JSON body a client would receive. */
function displayBody(amount: Amount): string {
  return JSON.stringify({ amount });
}

describe('the column the rule prescribes', () => {
  it('is numeric(20, 7) - read back from the database, not from the DDL that made it', async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>
    >(
      [
        'SELECT "column_name", "data_type", "numeric_precision", "numeric_scale"',
        'FROM information_schema.columns',
        'WHERE "table_name" = $1',
        'ORDER BY "column_name"',
      ].join('\n'),
      PROBE_TABLE,
    );

    // The whole list, including `id`: an assertion about two columns that silently
    // stopped matching would pass if it only looked at the ones it knows by name.
    expect(columns).toEqual([
      {
        column_name: 'exact_amount',
        data_type: 'numeric',
        numeric_precision: 20,
        numeric_scale: 7,
      },
      {
        column_name: 'float_amount',
        data_type: 'double precision',
        numeric_precision: 53,
        numeric_scale: null,
      },
      { column_name: 'id', data_type: 'integer', numeric_precision: 32, numeric_scale: 0 },
    ]);
  });

  it('is the same shape where it is actually used: `transactions.amount`', async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{ data_type: string; numeric_precision: number | null; numeric_scale: number | null }>
    >(
      [
        'SELECT "data_type", "numeric_precision", "numeric_scale"',
        'FROM information_schema.columns',
        'WHERE "table_name" = $1 AND "column_name" = $2',
      ].join('\n'),
      'transactions',
      'amount',
    );

    // The real column, read from the catalogue rather than from `schema.prisma`: the rule in
    // `money-discipline.ts` checks the schema file's *text*, and this checks what the database was
    // actually built with. A `Float` here would lose a digit at rest and no application code could
    // tell, which is the whole argument for asserting the type in two places.
    expect(columns).toEqual([{ data_type: 'numeric', numeric_precision: 20, numeric_scale: 7 }]);

    // That the value in this column survives a real write is
    // `test/payments.e2e-spec.ts`'s "round-trips a crafted 7-decimal amount" - asserted there
    // because that is where the write path lives, and this file stays a read-only witness to the
    // shape of the column.
  });

  it('holds thirteen integer digits, and refuses the fourteenth', async () => {
    // `9007199254740993` is 2^53 + 1 - the first integer a JS number cannot represent -
    // and sixteen digits. The column refusing it is the *good* outcome: a store that
    // accepted it would be one whose upper bound was a float's.
    await expect(store('9007199254740993')).rejects.toThrow(/numeric field overflow/);

    // And the largest value it does hold, so the bound above is shown to be the column's
    // rather than an order of magnitude away from it.
    const row = await store('9999999999999.9999999');

    expect(String(row.exact_amount)).toBe('9999999999999.9999999');
  });

  it('reports the shapes it read, which is what `Amount.fromDatabase` accepts', async () => {
    const row = await store(CRAFTED);

    // Prisma's `Decimal` for `numeric` (accepted structurally, so `common/money` needs no
    // import of the generated client), and a bare number for `double precision`.
    expect(typeof row.exact_amount).toBe('object');
    expect(typeof row.float_amount).toBe('number');
  });
  it('stores seven decimals, and hands back a shorter spelling of them', async () => {
    await store('1');

    // Two spellings of the same stored value, one step apart, and this is the step that
    // a test written from assumption got wrong the first time this file ran. Postgres
    // prints a `numeric` with the column's scale - `1.0000000` - and `::text` is how that
    // spelling is read (without the cast, `$queryRaw` hands back the same `Decimal` and
    // hides it). Prisma then renders the *shortest exact* form, `1`, which is what
    // `Amount.fromDatabase` receives in every test above.
    const rows = await prisma.$queryRawUnsafe<Array<{ stored: string }>>(
      `SELECT "exact_amount"::text AS "stored" FROM "${PROBE_TABLE}" WHERE "id" = $1`,
      PROBE_ID,
    );

    expect(rows[0]?.stored).toBe('1.0000000');

    // Both spellings are accepted - the one thing `fromDatabase` is deliberately
    // permissive about - and both arrive at the same canonical string.
    expect(String((await store('1')).exact_amount)).toBe('1');
    expect(Amount.fromDatabase('1.0000000').toString()).toBe('1');
    expect(Amount.fromDatabase('1').toString()).toBe('1');
  });
});

describe('create -> store -> display', () => {
  it('starts from a value a JS number cannot carry, which is why none of this is one', () => {
    expect(String(Number(CRAFTED))).not.toBe(CRAFTED);
  });

  for (const crafted of ROUND_TRIP_CASES) {
    it(`round-trips ${crafted} unchanged, string in and string out`, async () => {
      const created = Amount.fromString(crafted);
      const row = await store(created.toString());

      // What comes back is Prisma's `Decimal`, whose `toString()` is the *shortest* exact
      // form rather than the column's fixed-scale spelling (`1`, `1e-7`) - so the round
      // trip is asserted on the value. The stored scale is a separate claim, pinned in
      // 'stores seven decimals, and hands back a shorter spelling of them'.
      const displayed = Amount.fromDatabase(row.exact_amount);
      const [whole = '', fraction = ''] = crafted.split('.');

      expect(displayed.toString()).toBe(crafted);
      expect(displayed.toJSON()).toBe(crafted);
      expect(displayed.toStellarAmount()).toBe(
        `${whole}.${fraction.padEnd(MONEY_DECIMAL_PLACES, '0')}`,
      );
      expect(displayBody(displayed)).toBe(`{"amount":"${crafted}"}`);
    });
  }

  it('sends the amount as a string, and not the number a float column stored', async () => {
    const row = await store(CRAFTED);
    const body = JSON.parse(displayBody(Amount.fromDatabase(row.exact_amount))) as {
      amount: string;
    };

    expect(typeof body.amount).toBe('string');
    expect(body.amount).toBe(CRAFTED);
    // What the response would have carried if the column - or the field - had been a
    // number: the JSON number is a different value, and `JSON.parse` turns it into a
    // float, so no client could recover the original.
    expect(body.amount).not.toBe(String(row.float_amount));
  });
});

describe('the same value in a float column', () => {
  it('loses digits at rest, and loses them quietly', async () => {
    const row = await store(CRAFTED);

    expect(String(row.float_amount)).toBe('123456789012.12346');
    expect(String(row.float_amount)).not.toBe(CRAFTED);

    // And `fromDatabase` cannot tell: five decimal places is a value `numeric(20, 7)`
    // could legitimately have returned, so there is nothing in the number itself to
    // object to. This is the argument for the money rule being structural - a forbidden
    // column *type*, checked before the code runs - rather than a parser that catches
    // floats after they have already cost a digit.
    expect(() => Amount.fromDatabase(row.float_amount)).not.toThrow();
    expect(Amount.fromDatabase(row.float_amount).toString()).toBe('123456789012.12346');
  });

  it('loses them loudly when the float arithmetic that produced them is stored', async () => {
    // `0.1 + 0.2` is the canonical case, and the application cannot express it:
    // `fromString('0.30000000000000004')` is refused for its spelling and for its seven
    // decimal places. As SQL it goes straight in, which is what a float column in a later
    // step would be doing once a `number` had been added somewhere.
    await prisma.$executeRawUnsafe(
      `UPDATE "${PROBE_TABLE}" SET "float_amount" = 0.1::float8 + 0.2::float8 WHERE "id" = $1`,
      PROBE_ID,
    );
    const row = await read();

    expect(String(row.float_amount)).toBe('0.30000000000000004');
    // Seventeen decimal places: the shape `fromDatabase`'s docblock describes, firing on
    // real data rather than on a literal written by hand in `amount.spec.ts`.
    expect(() => Amount.fromDatabase(row.float_amount)).toThrow(InvalidAmountError);
    expect(() => Amount.fromDatabase(row.float_amount)).toThrow(/17 decimal places/);
  });
});

describe('the validator is the application, not the column', () => {
  it('rounds an eight-decimal value rather than refusing it', async () => {
    // The column enforces a *width*, not a spelling: scale 7 rounds, and `numeric(20, 7)`
    // has no opinion about a client sending eight decimals. So a value with eight of them
    // reaches the ledger as a different number unless something in front of the database
    // says no - which `fromString` does, asserted in the same test so the two halves
    // cannot drift apart.
    await prisma.$executeRawUnsafe(
      `UPDATE "${PROBE_TABLE}" SET "exact_amount" = 123456789012.12345678::numeric(20, 7) WHERE "id" = $1`,
      PROBE_ID,
    );
    const row = await read();

    expect(String(row.exact_amount)).toBe('123456789012.1234568');

    expect(() => Amount.fromString('123456789012.12345678')).toThrow(InvalidAmountError);
    expect(() => Amount.fromString('123456789012.12345678')).toThrow(/8 decimal places/);
  });
});
