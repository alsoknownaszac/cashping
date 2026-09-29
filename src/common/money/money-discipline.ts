import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The money rules nothing in this repository can otherwise state (Step 23).
 *
 * Step 23 asks for the Decimal handling to be "consistent everywhere", and the type
 * in `amount.ts` only covers the code that *chooses* to use it. The rules that make
 * it consistent are habits - "an amount is a string at the edge", "a money column is
 * `Decimal`, never `Float`", "no `number` for money" - and habits decay silently.
 *
 * oxlint cannot express them. It reports 103 `restriction` rules and none of them
 * can say "this identifier is money and this type is forbidden"; its plugin API is
 * not available in the pinned 1.58 (`oxlint --help` lists built-in plugin toggles
 * only, no JS plugins), and its default rule set does not flag `Float` in a Prisma
 * schema or `number` next to the word `amount`. So the check is this file: a
 * deterministic scan wired into `npm run lint` (`lint:money`), which is a step in
 * `.github/workflows/ci.yml`, so a violation fails a pull request the same way a
 * lint error does.
 *
 * ## It is a scan, not a compiler
 *
 * Deliberate, and the trade-off is worth naming. A checker built on the TypeScript
 * AST would resolve real types and see through aliases; it would also need a
 * type-checked parse of the whole project on every lint run, and it would still not
 * read `schema.prisma` - which is where the single most expensive mistake lives
 * (a `Float` column loses digits *at rest*, where no application code can recover
 * them). Text scanning with a comment-stripping pass catches the rules that matter
 * here in a few milliseconds. What it cannot do is follow an alias
 * (`type Money = number`) or see into a generic; both are named as gaps rather than
 * pretended away, and `money-discipline.spec.ts` runs the check against the real
 * repository so the claim "there are no violations today" is checked, not assumed.
 *
 * ## The rules
 *
 * | Rule | What it forbids | Why |
 * | --- | --- | --- |
 * | `money-import-depth` | importing `decimal.js` outside `src/common/money/` | one place decides how money is represented; a second importer is a second policy |
 * | `money-column-not-float` | a money-named Prisma field typed `Float`/`Real`/`DoublePrecision` | a float column is where digits are lost in a way no later code can undo |
 * | `money-not-a-number-in-dto` | a money member of a `*.dto.ts` typed `number` or `Decimal` | the wire format is a string; `Decimal` on the wire serializes as decimal.js internals |
 * | `money-not-a-number` | a money-named variable, parameter or property typed `number` | the rule the build sequence states, in the one shape it can be scanned for |
 *
 * Names are matched after normalising to snake_case, so `amount`, `feeAmount`,
 * `total_amount` and `recipientAmount` are all money. The word list is
 * `MONEY_WORDS` below - add to it when the API grows a new word for money, because
 * a rule that misses the field it was written for is worse than no rule.
 */

/** Every word this check treats as money, matched on snake_case boundaries. */
export const MONEY_WORDS = ['amount', 'balance', 'fee', 'price', 'total', 'subtotal'] as const;

/** Where a violation was found, and what it is. */
export interface Violation {
  /** Repository-relative, POSIX separators - what a CI log should say. */
  readonly file: string;
  /** One-based line number, or `0` for a file-level rule. */
  readonly line: number;
  /** The rule id from the table above. */
  readonly rule: string;
  /** What is wrong, and what to write instead. */
  readonly detail: string;
}

/** One file's path (relative, POSIX) and text, so the checks are pure functions. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** The one directory allowed to import `decimal.js`. Trailing slash on purpose. */
const MONEY_MODULE = 'src/common/money/';

/** Rule ids, so a test can assert about one of them without matching prose. */
export const RULES = {
  importDepth: 'money-import-depth',
  columnNotFloat: 'money-column-not-float',
  notANumberInDto: 'money-not-a-number-in-dto',
  notANumber: 'money-not-a-number',
} as const;

const DECIMAL_JS_IMPORT = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]decimal\.js['"]/;
const FLOAT_COLUMN = /@db\.(?:Real|DoublePrecision|Float)|\b(?:Float|Real|DoublePrecision)\b/;
const DTO_FILE = /\.dto\.ts$/;
const SPEC_FILE = /\.(?:e2e-)?spec\.ts$/;
const MONEY_WORD_PATTERN = new RegExp(`(?:^|_)(?:${MONEY_WORDS.join('|')})(?:s)?(?:_|$)`);

/** `feeAmount` -> `fee_amount`, `total_amount` -> `total_amount`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Whether a name denotes money, by `MONEY_WORDS`. */
export function isMoneyName(name: string): boolean {
  return MONEY_WORD_PATTERN.test(snakeCase(name));
}

/**
 * The file with comments replaced by spaces - same length, same line breaks.
 *
 * A rule that only reads code cannot be tripped by prose. The caveat worth knowing:
 * a `//` inside a *string literal* (a URL in a Swagger description) blanks the rest
 * of its line too, so a violation sharing a line with a URL would be missed. The cost
 * of the alternative - a type-checked parse for a check whose subject is text - is
 * higher than the risk, and the risk is a line that does not exist in this codebase.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, ' '));
}

/** A field declaration inside one `model` block of `schema.prisma`. */
interface PrismaField {
  readonly model: string;
  readonly name: string;
  readonly type: string;
  readonly line: number;
  /** The whole declaration line, so attributes (`@db.Real`) are visible. */
  readonly text: string;
}

/**
 * The scalar fields of every model in `schema.prisma`.
 *
 * A five-line state machine rather than a Prisma schema parser: this needs the field
 * name, its scalar type and its attributes, and everything else in the file (blocks,
 * indexes, relations, comments) is skipped by the same code path that ignores a line
 * starting with `@@` or `//`.
 */
export function prismaFields(schema: string): PrismaField[] {
  const fields: PrismaField[] = [];
  let model: string | undefined;

  for (const [index, text] of schema.split('\n').entries()) {
    const line = index + 1;

    const opening = /^\s*model\s+(\w+)\s*\{/.exec(text);

    if (opening) {
      model = opening[1] as string;
      continue;
    }

    if (/^\s*\}/.test(text)) {
      model = undefined;
      continue;
    }

    if (model === undefined) {
      continue;
    }

    const field = /^\s*(\w+)\s+([A-Za-z][\w.[\]]*)(\[\])?(\?)?/.exec(text);

    if (!field || text.trim().startsWith('@@') || text.trim().startsWith('//')) {
      continue;
    }

    fields.push({ model, name: field[1] as string, type: field[2] as string, line, text });
  }

  return fields;
}

/** Rule `money-import-depth`: `decimal.js` is imported in exactly one directory. */
function checkImportDepth(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    if (file.path.startsWith(MONEY_MODULE)) {
      continue;
    }

    for (const [index, line] of file.text.split('\n').entries()) {
      if (DECIMAL_JS_IMPORT.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          rule: RULES.importDepth,
          detail: `imports decimal.js, which only ${MONEY_MODULE} may do - take an Amount from there instead`,
        });
      }
    }
  }

  return violations;
}

/** Rule `money-column-not-float`: a money column is `Decimal`, never a float. */
function checkSchemaColumns(schema: string): Violation[] {
  const violations: Violation[] = [];

  for (const field of prismaFields(schema)) {
    if (!isMoneyName(field.name) || !FLOAT_COLUMN.test(field.text)) {
      continue;
    }

    violations.push({
      file: 'prisma/schema.prisma',
      line: field.line,
      rule: RULES.columnNotFloat,
      detail: `${field.model}.${field.name} is ${field.type}, and a float column loses digits at rest - use Decimal @db.Decimal(20, 7)`,
    });
  }

  return violations;
}

/**
 * A member declaration in a DTO: indented, named, annotated, terminated.
 *
 * The `;` and the indent are what keep this from matching a `const` at the top of the
 * file or a key inside an `@ApiProperty({ ... })` example object.
 */
const DTO_MEMBER = /^\s{2,}(?:readonly\s+)?(\w+)[?!]?\s*:\s*([^;{}]+);/;

/** Rule `money-not-a-number-in-dto`: a money member of a DTO is a string on the wire. */
function checkDtoMembers(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    if (!DTO_FILE.test(file.path)) {
      continue;
    }

    for (const [index, line] of stripComments(file.text).split('\n').entries()) {
      const member = DTO_MEMBER.exec(line);
      const name = member?.[1];
      const type = member?.[2];

      if (name === undefined || type === undefined || !isMoneyName(name)) {
        continue;
      }

      if (!/\b(?:number|Number|Decimal)\b/.test(type)) {
        continue;
      }

      violations.push({
        file: file.path,
        line: index + 1,
        rule: RULES.notANumberInDto,
        detail: `${name} is ${type.trim()} at the edge, and an amount crosses the wire as a string - see src/common/money/amount.ts`,
      });
    }
  }

  return violations;
}

/**
 * Rule `money-not-a-number`: no money-named variable, parameter or property may be
 * annotated `number`.
 *
 * Specs are the one skip, because their job is to hold the floats and strings that
 * prove the failure mode (`amount.spec.ts` asserts `String(0.1 + 0.2)`), and a rule
 * that forbade the evidence would make the claim untestable. `src/common/money/` is
 * deliberately *not* skipped: a money value held as a `number` would be just as wrong
 * in the module that defines `Amount` as anywhere else, and the module has no such
 * line today - so the rule applies there too and the spec pins that it does.
 *
 * A Prisma `Decimal` in a service is *not* flagged here - reading one and passing it
 * through `Amount.fromDatabase` is the intended path, and the DTO rule covers the one
 * place a `Decimal` must not reach. A bare `number` is flagged everywhere, because
 * there is no correct amount of money for it to hold.
 */
function checkNumberAnnotations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    if (SPEC_FILE.test(file.path)) {
      continue;
    }

    for (const [index, line] of stripComments(file.text).split('\n').entries()) {
      for (const [, name] of line.matchAll(/(\w+)\s*\??\s*:\s*(?:number|Number)\b/g)) {
        if (name === undefined || !isMoneyName(name)) {
          continue;
        }

        violations.push({
          file: file.path,
          line: index + 1,
          rule: RULES.notANumber,
          detail: `${name} is typed number, and a JS number cannot hold a 7-decimal amount - use an Amount from src/common/money/amount.ts`,
        });
      }
    }
  }

  return violations;
}

/**
 * Every rule, over every file - the function the CLI and the spec both call.
 *
 * Pure on purpose: `checkMoneyDiscipline` below does the reading, and this does the
 * judging, so the spec can feed it fabricated sources and prove each rule fires.
 * Sorted by file, then line, then rule, so the output is stable between runs (the
 * order of the checks above is an implementation detail, and a CI log that reorders
 * itself is a CI log nobody diffs).
 */
export function findViolations(files: readonly SourceFile[], schema: string): Violation[] {
  return [
    ...checkImportDepth(files),
    ...checkSchemaColumns(schema),
    ...checkDtoMembers(files),
    ...checkNumberAnnotations(files),
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

/** The schema, which is not a `.ts` file but holds one of the four rules. */
export const SCHEMA_PATH = 'prisma/schema.prisma';

/** What this check reads: production code and the e2e specs. */
const SCANNED_DIRECTORIES = ['src', 'test'] as const;

/** Generated Prisma output (which imports decimal.js on purpose), and build output. */
const EXCLUDED_DIRECTORIES = ['src/generated', 'node_modules', 'dist'] as const;

/** `a/b/c.ts`, whatever the platform's separator is. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

async function collectTypeScript(
  directory: string,
  root: string,
  found: SourceFile[],
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = toPosix(relative(root, path));

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.some((excluded) => relativePath.startsWith(excluded))) {
        continue;
      }

      await collectTypeScript(path, root, found);
      continue;
    }

    if (entry.name.endsWith('.ts')) {
      found.push({ path: relativePath, text: await readFile(path, 'utf8') });
    }
  }
}

/** Every `.ts` file under `src/` and `test/`, generated output excluded. */
export async function readSources(repoRoot: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];

  for (const directory of SCANNED_DIRECTORIES) {
    await collectTypeScript(join(repoRoot, directory), repoRoot, found);
  }

  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The check as CI runs it: read the repository, judge it, report what is wrong.
 *
 * `scanned` is part of the report because a check that silently reads nothing passes
 * for the wrong reason: the spec asserts that this number is in the dozens, so
 * "no violations" cannot be the result of a scan that found no files.
 */
export interface DisciplineReport {
  /** How many `.ts` files were read, so a passing run can be shown to be non-vacuous. */
  readonly scanned: number;
  /** Empty is the passing state. */
  readonly violations: readonly Violation[];
}

export async function checkMoneyDiscipline(repoRoot: string): Promise<DisciplineReport> {
  const files = await readSources(repoRoot);
  const schema = await readFile(join(repoRoot, SCHEMA_PATH), 'utf8');

  return { scanned: files.length, violations: findViolations(files, schema) };
}
