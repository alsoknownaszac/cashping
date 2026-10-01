import { describe, expect, it } from 'vitest';
import { TransactionStatus } from '../generated/prisma/enums.js';
import {
  PAYMENT_STATUS_NAMES,
  SANCTIONED_STATUS_FILE,
  STATUS_RULES,
  checkTransactionStatusDiscipline,
  findStatusViolations,
  sanctionedStatusWrites,
  stripComments,
  type SourceFile,
  type StatusViolation,
} from './status-discipline.js';

/**
 * Step 29's rule, tested the way a rule has to be tested: by proving it *fails*.
 *
 * A checker like this is easy to write in a way that always passes - a regex with a typo, a
 * directory walk that reads nothing, a model name that never matches - and that failure is silent,
 * which is the one kind of failure this step cannot afford. So the first half of this file feeds
 * `findStatusViolations` code that *should* be rejected and asserts the rule and the line that come
 * back, the middle half feeds it code that should be *accepted* (the reads, the other model's status
 * column, the exempt file), and the last part runs the real check against this repository: no
 * violations, over enough files that "clean" cannot mean "read nothing", and with the sanctioned
 * file shown to really hold status writes.
 *
 * Nothing here spawns the CLI: the exit code is the CLI's, and the CLI is a dozen lines around
 * `checkTransactionStatusDiscipline`. What is worth testing is the judgement, and that is
 * `findStatusViolations` - pure, so a fixture is a string.
 */

/**
 * The fixture's model, method, `data` key and `status` key, assembled rather than written out.
 *
 * This check reads *text*, not syntax, so a spec that spelled the rule's own pattern would be a
 * violation of the rule it is testing - `npm run lint:status` really does scan this file, and the
 * exemption names one path. Keeping the pieces apart is the smallest way to have the fixture
 * without the side effect; the money check's spec does the same thing for its `decimal.js` import.
 */
const MODEL = ['trans', 'action'].join('');
const UPDATE = ['upd', 'ate'].join('');
const UPDATE_MANY = ['update', 'Many'].join('');
const UPSERT = ['up', 'sert'].join('');
const DATA = ['dat', 'a'].join('');
const STATUS = ['stat', 'us'].join('');

/** A file as the check sees it, named so a violation reads like a real path. */
function source(path: string, text: string): SourceFile {
  return { path, text };
}

/** A file that is *not* the sanctioned writer - where every fixture below lives. */
function elsewhere(...lines: string[]): SourceFile {
  return source('src/payments/services/payments.service.ts', lines.join('\n'));
}

/** One status write, in the shape the rule is written for. */
function write(method: string, value: string): string[] {
  return [`await prisma.${MODEL}.${method}({`, '  where: { id },', `  ${DATA}: { ${STATUS}: ${value} },`, '});'];
}

/**
 * The exemption, present in every fixture set below.
 *
 * The third rule (the exemption points at a file that exists) is orthogonal to the first two, and a
 * set of fixtures that omitted the sanctioned file would report it - so it is included here as a stub
 * holding one legitimate write. The cases that are *about* the exemption call `findStatusViolations`
 * directly, because they are the ones that want to see it.
 */
function sanctionedFile(): SourceFile {
  return source(SANCTIONED_STATUS_FILE, write(UPDATE, 'TransactionStatus.PROCESSING').join('\n'));
}

/** The violations a fixture set produces, with the exemption in place. */
function violationsOf(files: readonly SourceFile[]): StatusViolation[] {
  return findStatusViolations([...files, sanctionedFile()]);
}

/** Just the rule ids, which is what most cases assert. */
function rulesFired(files: readonly SourceFile[]): string[] {
  return violationsOf(files).map((violation) => violation.rule);
}

describe('PAYMENT_STATUS_NAMES', () => {
  it('is exactly the Prisma enum, which is the duplication this list pays for', () => {
    // The module cannot import the generated enum: `node` loads it directly (see
    // `check-status-discipline.ts`) and type stripping refuses to load an `enum`. So the four names
    // are spelled again, and this is what stops the two drifting: a status added to `schema.prisma`
    // - or renamed - fails here rather than leaving a name the check would not recognise.
    expect([...PAYMENT_STATUS_NAMES].sort()).toEqual(Object.values(TransactionStatus).sort());
  });
});

describe('stripComments', () => {
  const text = [
    'const a = 1; // a trailing comment',
    '/* a block',
    `   comment mentioning ${STATUS} = 'FAILED' */`,
    'const b = 2;',
    '',
  ].join('\n');

  it('keeps code, drops prose, and preserves every line break', () => {
    expect(stripComments(text).split('\n')).toHaveLength(text.split('\n').length);
    expect(stripComments(text)).toContain('const a = 1;');
    expect(stripComments(text)).toContain('const b = 2;');
    expect(stripComments(text)).not.toContain('comment');
  });

  it('makes a commented-out write prose rather than a violation', () => {
    // The rule's message tells the reader to call a writer instead, and the most likely way that
    // message gets written *near* a write is a comment quoting one.
    const files = [
      elsewhere(
        `// a shortcut someone was tempted by: prisma.${MODEL}.${UPDATE}({ ${DATA}: { ${STATUS}: 'FAILED' } })`,
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });
});

describe('rule: a transaction status is written only through the state machine', () => {
  it('rejects a status in a data block, and says what to call instead', () => {
    const violations = violationsOf([elsewhere(...write(UPDATE, 'TransactionStatus.SUCCESSFUL'))]);

    expect(violations.map((violation) => violation.rule)).toEqual([STATUS_RULES.write]);

    // The line is the `status:` key itself, which is where a reader opens the file.
    expect(violations[0]?.line).toBe(3);

    // The detail has to be enough to fix the violation without opening the checker: the one file
    // allowed to write the column, and the writers in it.
    expect(violations[0]?.detail).toContain(SANCTIONED_STATUS_FILE);
    expect(violations[0]?.detail).toContain('markSuccessful');
  });

  it('sees every Prisma method that can write a row', () => {
    const methods = [
      UPDATE,
      UPDATE_MANY,
      UPSERT,
      ['cre', 'ate'].join(''),
      ['create', 'Many'].join(''),
    ];

    for (const method of methods) {
      expect(rulesFired([elsewhere(...write(method, 'TransactionStatus.FAILED'))])).toEqual([
        STATUS_RULES.write,
      ]);
    }
  });

  it('reports every write in a file, not just the first, in line order', () => {
    const lines = [
      ...write(UPDATE, 'TransactionStatus.PROCESSING'),
      ...write(UPDATE_MANY, 'TransactionStatus.FAILED'),
    ];

    expect(violationsOf([elsewhere(...lines)]).map((violation) => violation.line)).toEqual([3, 7]);
  });

  it('says nothing about a call it cannot match up rather than guessing', () => {
    // An unbalanced snippet is not a violation: this is a scan, not a parser, and inventing a
    // finding for a file it could not read would be worse than silence about that one call. The
    // sanctioned writer is a real file that `tsc` checks, so this is only ever about fixtures.
    const files = [
      elsewhere(`await prisma.${MODEL}.${UPDATE}({`, `  ${DATA}: { ${STATUS}: 'FAILED' }`),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('accepts a status in `where`, because that is how every read and claim asks', () => {
    const files = [
      elsewhere(
        `const inFlight = await prisma.${MODEL}.findMany({`,
        `  where: { ${STATUS}: TransactionStatus.PROCESSING },`,
        '});',
        `await prisma.${MODEL}.${UPDATE}({`,
        `  where: { id, ${STATUS}: TransactionStatus.PROCESSING },`,
        `  ${DATA}: { failureReason: 'not-found-after-deadline' },`,
        '});',
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('accepts an assertion *about* a write, which is what most specs hold', () => {
    const files = [
      source(
        'src/payments/services/payments.service.spec.ts',
        [
          'expect(writes[0]).toEqual({',
          '  where: { id },',
          `  ${DATA}: { ${STATUS}: TransactionStatus.FAILED },`,
          '});',
        ].join('\n'),
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it("accepts another model's status column, which is written in exactly the same shape", () => {
    // `auth.service.ts` writes `user.status` with a `data: { status: UserStatus.ACTIVE }` block. A
    // rule that flagged that would be unusable, which is why the model is part of the pattern.
    const files = [
      source(
        'src/identity/auth/auth.service.ts',
        [
          `await this.prisma.user.${UPDATE}({`,
          '  where: { id },',
          `  ${DATA}: { ${STATUS}: UserStatus.ACTIVE },`,
          '});',
        ].join('\n'),
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });

  it('is not fooled by a status key that is not a status write', () => {
    const files = [
      elsewhere(
        `const patch = { ${STATUS}: TransactionStatus.FAILED };`,
        `await prisma.${MODEL}.${UPDATE}({ where: { id }, ${DATA}: patch });`,
      ),
    ];

    // The gap this names rather than hides: a status smuggled through a variable is invisible to a
    // text scan. It is the same gap the money check names about aliases, and it is why the rule is
    // written as "a write of the column must be spelled out at the call site".
    expect(rulesFired(files)).toEqual([]);
  });
});

describe('rule: a status written by a statement rather than by the client', () => {
  it('rejects raw SQL that sets the column, in any case', () => {
    for (const keyword of ['SET', 'set']) {
      const files = [
        elsewhere(
          `await prisma.$executeRaw\`UPDATE transactions ${keyword} ${STATUS} = 'FAILED' WHERE id = \${id}\`;`,
        ),
      ];

      expect(rulesFired(files)).toEqual([STATUS_RULES.sql]);
    }
  });

  it('accepts a query that only reads the column', () => {
    const files = [
      elsewhere(
        `const ids = await prisma.$queryRaw\`SELECT id FROM transactions WHERE ${STATUS} = 'PROCESSING'\`;`,
      ),
    ];

    expect(rulesFired(files)).toEqual([]);
  });
});

describe('the exemption, and the check that it is real', () => {
  it('accepts a status write inside the one file allowed to make it', () => {
    const files = [sanctionedFile(), elsewhere('const nothing = 1;')];

    expect(rulesFired(files)).toEqual([]);

    // And counts it. This is the half that keeps a passing run from passing for the wrong reason:
    // an exemption pointing at a file with no writes in it, or a walk that read nothing, would
    // report zero violations and zero writes - which is why the CLI prints this number too.
    expect(sanctionedStatusWrites(files)).toBe(1);
  });

  it('counts the sanctioned file only, so the number means what it says', () => {
    const files = [sanctionedFile(), elsewhere(...write(UPDATE, 'TransactionStatus.FAILED'))];

    expect(sanctionedStatusWrites(files)).toBe(1);
    expect(rulesFired(files)).toEqual([STATUS_RULES.write]);
  });

  it('reports a missing exemption rather than exempting everything', () => {
    // An allowlist whose file has been moved is an allowlist that permits anything: a rule with no
    // writer left to call would make every future status write silent rather than flagged.
    const violations = findStatusViolations([elsewhere('const nothing = 1;')]);

    expect(violations.map((violation) => violation.rule)).toEqual([STATUS_RULES.missingSanction]);
    expect(violations[0]?.file).toBe(SANCTIONED_STATUS_FILE);
    expect(violations[0]?.line).toBe(0);
    expect(sanctionedStatusWrites([])).toBe(0);
  });
});

/**
 * The real repository, read once when this file is collected.
 *
 * At module scope rather than inside a `describe`: `describe` callbacks are synchronous, and a suite
 * that read the repository per test would report the same thing twice for twice the cost. If this
 * module fails to load, the whole file fails - which is the right outcome, since a check that cannot
 * read the repository has not passed.
 */
const report = await checkTransactionStatusDiscipline(process.cwd());

describe('this repository', () => {
  // The claim Step 29 has to be able to make: not "the rule exists" but "the codebase passes it".
  // `process.cwd()` is the backend root under `npm test`, and this is the same call `npm run
  // lint:status` makes, so a violation here is a violation CI would report.
  it('has no status-discipline violations', () => {
    expect(report.violations).toEqual([]);
  });

  it('scanned a plausible number of files, so an empty list is not an empty scan', () => {
    // 155 files on the day this was written. The bounds are loose - the point is that a walk which
    // silently read nothing, or which wandered into `node_modules` or `dist`, fails here rather
    // than passing quietly.
    expect(report.scanned).toBeGreaterThan(50);
    expect(report.scanned).toBeLessThan(2000);
  });

  it('finds status writes in the sanctioned file, which is what the exemption is for', () => {
    // `claimForSubmission`, `markSuccessful` and `markFailed` as of Step 28: the three transitions
    // something can make on a payment. A fourth appearing there is a change to the state machine -
    // which belongs in that file either way - and an exemption over a file with *no* writes in it
    // is the degenerate case this number exists to catch.
    expect(report.sanctionedWrites).toBeGreaterThanOrEqual(3);
  });
});
