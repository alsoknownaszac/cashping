import { describe, expect, it } from 'vitest';
import {
  MONEY_WORDS,
  RULES,
  checkMoneyDiscipline,
  findViolations,
  isMoneyName,
  prismaFields,
  stripComments,
  type SourceFile,
} from './money-discipline.js';

/**
 * The money rules, tested the way a rule has to be tested: by proving it *fails*.
 *
 * A checker like this is easy to write in a way that always passes - a regex with a
 * typo, a directory walk that finds no files, a name-matcher that never matches - and
 * the failure mode is silent, which is exactly the failure mode the whole step exists
 * to prevent. So the first half of this file feeds `findViolations` code that *should*
 * be rejected and asserts the rule id that comes back, and the second half runs the
 * real check against this repository: 0 violations, over a number of files large
 * enough that "clean" cannot mean "read nothing".
 *
 * Nothing here spawns the CLI: the exit code is the CLI's, and the CLI is six lines
 * around `checkMoneyDiscipline`. What is worth testing is the judgement, and that is
 * `findViolations` - pure, so a fixture is a string.
 */

/** A file as the check sees it, named so a violation reads like a real path. */
function source(path: string, text: string): SourceFile {
  return { path, text };
}

/** Just the rule ids `findViolations` returns, which is what most cases assert. */
function rulesFired(files: readonly SourceFile[], schema = ''): string[] {
  return findViolations(files, schema).map((violation) => violation.rule);
}

/**
 * `import { Decimal } from 'decimal.js';`, assembled instead of written literally.
 *
 * A literal would make *this file* a violation of the rule it is testing, which is
 * both a nuisance (`npm run lint:money` would fail on the spec) and a fair
 * demonstration that the rule reads text rather than syntax. Keeping the two words
 * apart is the smallest way to have the fixture without the side effect.
 */
const DECIMAL_JS = ['decimal', 'js'].join('.');
const DECIMAL_IMPORT = `import { Decimal } from '${DECIMAL_JS}';`;

describe('isMoneyName', () => {
  it('matches every word in MONEY_WORDS, singular and plural, so the pattern cannot drift', () => {
    // The list and the pattern are two halves of one decision. If a word is added to
    // MONEY_WORDS and the pattern stops matching it, this is what fails.
    for (const word of MONEY_WORDS) {
      expect(isMoneyName(word)).toBe(true);
      expect(isMoneyName(`${word}s`)).toBe(true);
      expect(isMoneyName(`recipient_${word}`)).toBe(true);
    }
  });

  it('matches the naming this codebase uses, and nothing that merely looks like money', () => {
    for (const money of ['amount', 'feeAmount', 'total_amount', 'amounts', 'balance', 'subtotal']) {
      expect(isMoneyName(money)).toBe(true);
    }

    // `street` has the letters of a money word in it, `count` and `ratio` are numbers
    // that are legitimately plain numbers, and `rating` is the float column a table
    // might really have - if this rule flagged those, it would be unusable.
    for (const notMoney of ['street', 'count', 'ratio', 'rating', 'id', 'createdAt']) {
      expect(isMoneyName(notMoney)).toBe(false);
    }
  });
});

describe('stripComments', () => {
  const text = [
    'const a = 1; // a trailing comment',
    '/* a block',
    '   comment */',
    'const b = 2;',
    '',
  ].join('\n');

  it('keeps code, drops prose, and preserves every line break', () => {
    const stripped = stripComments(text);

    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
    expect(stripped).not.toContain('a trailing comment');
    expect(stripped).not.toContain('block');
    // Line numbers are the whole point of a `file:line` report, so the blanking must
    // not change the shape of the file.
    expect(stripped.split('\n').length).toBe(text.split('\n').length);
    expect(stripped.split('\n')[3]).toBe('const b = 2;');
  });
});

describe('prismaFields', () => {
  const schema = [
    'datasource db {',
    '  provider = "postgresql"',
    '}',
    '',
    'model Payment {',
    '  id       String   @id',
    '  amount   Decimal  @db.Decimal(20, 7)',
    '  rating   Float',
    '  senderId String',
    '  sender   User     @relation(fields: [senderId], references: [id])',
    '',
    '  @@index([senderId])',
    '}',
  ].join('\n');

  it('reads name, type and line for the fields of a model', () => {
    const fields = prismaFields(schema);

    expect(fields.map((field) => field.name)).toEqual([
      'id',
      'amount',
      'rating',
      'senderId',
      'sender',
    ]);
    expect(fields[1]).toMatchObject({ model: 'Payment', type: 'Decimal', line: 7 });
    expect(fields[1]?.text).toContain('@db.Decimal(20, 7)');
  });

  it('skips block attributes and anything outside a model', () => {
    expect(prismaFields(schema).some((field) => field.name.startsWith('@@'))).toBe(false);
    expect(prismaFields(schema).every((field) => field.model === 'Payment')).toBe(true);
  });
});

describe('rule: a money column is never a float', () => {
  const schema = (field: string): string => ['model Payment {', `  ${field}`, '}'].join('\n');

  it('rejects every float type Prisma can generate, and says what to write instead', () => {
    for (const field of [
      'amount   Float',
      'amount   Float   @db.Real',
      'fee      Real',
      'subtotal Float   @db.DoublePrecision',
      'total    DoublePrecision',
    ]) {
      const violations = findViolations([], schema(field));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'prisma/schema.prisma',
        rule: RULES.columnNotFloat,
      });
      expect(violations[0]?.detail).toContain('Decimal @db.Decimal(20, 7)');
    }
  });

  it('accepts the column this step prescribes, and leaves floats that are not money alone', () => {
    expect(rulesFired([], schema('amount  Decimal @db.Decimal(20, 7)'))).toEqual([]);
    // A rating is a float on purpose; the rule is about money, not about floats.
    expect(rulesFired([], schema('rating Float'))).toEqual([]);
    // A relation whose name is money is still not a column.
    expect(rulesFired([], schema('balance Balance?'))).toEqual([]);
  });

  it('is not tripped by a commented-out column, because a comment is not a column', () => {
    expect(rulesFired([], schema('// amount Float'))).toEqual([]);
  });
});

describe('rule: an amount crosses the wire as a string', () => {
  const DTO = 'src/payments/dto/send-payment.dto.ts';

  it('rejects a money member typed number or Decimal in a DTO', () => {
    const violations = findViolations(
      [
        source(
          DTO,
          [
            'export class SendPaymentDto {',
            '  recipient!: string;',
            '  amount!: number;',
            '  balance: Decimal;',
            '}',
          ].join('\n'),
        ),
      ],
      '',
    );

    expect(violations.map((violation) => violation.line)).toEqual([3, 4]);
    expect(violations.map((violation) => violation.rule)).toEqual([
      RULES.notANumberInDto,
      RULES.notANumberInDto,
    ]);
    expect(violations[0]?.detail).toContain('crosses the wire as a string');
  });

  it('accepts a string, and ignores numbers that are not money', () => {
    const files = [
      source(
        DTO,
        [
          'export class SendPaymentDto {',
          '  amount!: string;',
          '  readonly amounts?: string[];',
          '  count!: number;',
          '}',
        ].join('\n'),
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('does not read a decorator example as a member', () => {
    // The shape that would make this rule annoying: an `@ApiProperty` example object
    // holds exactly the key/value pairs a DTO member holds.
    const files = [
      source(
        DTO,
        [
          'export class SendPaymentDto {',
          "  @ApiProperty({ example: '1.5', description: 'amount to send' })",
          '  amount!: string;',
          '}',
        ].join('\n'),
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('rejects an array of numbers too, since the wire format is a string either way', () => {
    const files = [source(DTO, ['export class X {', '  amounts!: number[];', '}'].join('\n'))];

    expect(rulesFired(files)).toEqual([RULES.notANumberInDto]);
  });
});

describe('rule: no money-named number', () => {
  const SERVICE = 'src/payments/payments.service.ts';

  it('rejects a money-named local, parameter or property typed number', () => {
    const violations = findViolations(
      [
        source(
          SERVICE,
          [
            'export class PaymentsService {',
            '  private readonly fee: number = 0.1;',
            '  send(amount: number, recipient: string): void {',
            '    const total: number = amount + this.fee;',
            '    let balanceUsd: number | null = null;',
            '  }',
            '}',
          ].join('\n'),
        ),
      ],
      '',
    );

    expect(violations.map((violation) => violation.line)).toEqual([2, 3, 4, 5]);
    expect(new Set(violations.map((violation) => violation.rule))).toEqual(
      new Set([RULES.notANumber]),
    );
  });

  it('accepts an Amount, and reads prose as prose', () => {
    const files = [
      source(
        SERVICE,
        [
          'export class PaymentsService {',
          '  send(amount: Amount): void {',
          '    // the amount: number of stroops used to be a float here',
          '    const fee: Amount = Amount.fromString("0.1");',
          '  }',
          '}',
        ].join('\n'),
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('applies inside src/common/money itself, which is not a special case', () => {
    const files = [source('src/common/money/amount.ts', 'const amount: number = 1;')];

    expect(rulesFired(files)).toEqual([RULES.notANumber]);
  });

  it('skips specs, because the spec for this rule has to hold a float', () => {
    const files = [
      source('src/payments/payments.service.spec.ts', 'const amount: number = 0.1 + 0.2;'),
      source('test/payments.e2e-spec.ts', 'const balance: number = 0.1 + 0.2;'),
    ];

    expect(rulesFired(files)).toEqual([]);
  });
});

describe('rule: decimal.js is imported in one directory', () => {
  it('rejects an import anywhere else, and accepts it in the money module', () => {
    const elsewhere = [source('src/payments/payments.service.ts', DECIMAL_IMPORT)];
    const inTheMoneyModule = [source('src/common/money/amount.ts', DECIMAL_IMPORT)];

    expect(rulesFired(elsewhere)).toEqual([RULES.importDepth]);
    expect(rulesFired(inTheMoneyModule)).toEqual([]);
    expect(findViolations(elsewhere, '')[0]?.detail).toContain('src/common/money/');
  });

  it('sees the shapes an import can take, including a lazily imported one', () => {
    for (const text of [
      `import Decimal from '${DECIMAL_JS}';`,
      `const Decimal = require('${DECIMAL_JS}');`,
      `const { Decimal } = await import('${DECIMAL_JS}');`,
    ]) {
      expect(rulesFired([source('src/payments/payments.service.ts', text)])).toEqual([
        RULES.importDepth,
      ]);
    }
  });
});

/**
 * The real repository, read once when this file is collected.
 *
 * At module scope rather than inside the `describe`: `describe` callbacks are
 * synchronous, and a suite that read the repository per test would report the same
 * thing twice for twice the cost. If this module fails to load, the whole file fails,
 * which is the right outcome - a check that cannot read the repository has not passed.
 */
const report = await checkMoneyDiscipline(process.cwd());

describe('this repository', () => {
  // The claim Step 23 has to be able to make: not "the rule exists" but "the codebase
  // passes it". `process.cwd()` is the backend root under `npm test`.
  it('has no money-discipline violations', () => {
    expect(report.violations).toEqual([]);
  });

  it('scanned a plausible number of files, so an empty list is not an empty scan', () => {
    // 119 files on the day this was written. The bounds are loose - the point is that
    // a walk that silently read nothing, or one that wandered into node_modules or
    // dist, fails here rather than passing quietly.
    expect(report.scanned).toBeGreaterThan(50);
    expect(report.scanned).toBeLessThan(1000);
  });
});
