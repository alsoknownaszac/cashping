import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The one file allowed to write a payment's `status` column (Step 29).
 *
 * The rule this check enforces is the build sequence's sentence - "no direct status writes from
 * anywhere else in the codebase, so the state machine can't be bypassed by a future shortcut" -
 * and the file is the *whole* of the exemption on purpose: one path, so the rule's message can
 * name it and a reader can go and read every write in one sitting.
 */
export const SANCTIONED_STATUS_FILE = 'src/payments/services/transaction-status.ts';

/**
 * The four statuses, as text.
 *
 * Spelled again rather than imported from `src/generated/prisma/enums.ts`, and that duplication is
 * carried by the spec: this module is loaded by `node` directly (see
 * `check-status-discipline.ts` for why, and for what type stripping refuses to load), so it has to
 * stay importable by the type-stripping loader - and `status-discipline.spec.ts` asserts that this
 * list *is* the enum's members, so the two cannot drift apart silently.
 */
export const PAYMENT_STATUS_NAMES = ['PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED'] as const;

/**
 * The rule ids, so a test can assert about one without matching prose.
 *
 * `transaction-status-write` is the one the step's audit item names: a status written through
 * Prisma's `data` somewhere other than the sanctioned file. `transaction-status-sql` is its twin
 * for the one other way to write the column - raw SQL - because the TypeScript check cannot see a
 * string that a later `$executeRaw` will send to Postgres.
 */
export const STATUS_RULES = {
  write: 'transaction-status-write',
  sql: 'transaction-status-sql',
  missingSanction: 'transaction-status-sanction-missing',
} as const;

/** Where a violation was found, and what it is. Same shape as the money check's. */
export interface StatusViolation {
  /** Repository-relative, POSIX separators - what a CI log should say. */
  readonly file: string;
  /** One-based line number, or `0` for a file-level rule. */
  readonly line: number;
  /** The rule id from above. */
  readonly rule: string;
  /** What is wrong, and what to write instead. */
  readonly detail: string;
}

/** One file's path (relative, POSIX) and text, so the checks are pure functions. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** What this check read, and what it found. */
export interface StatusDisciplineReport {
  /** How many `.ts` files were read, so a passing run can be shown to be non-vacuous. */
  readonly scanned: number;
  /**
   * How many status writes the sanctioned file holds.
   *
   * The other half of "not vacuous": a scan that read nothing, or whose exemption pointed at a
   * file with no writes in it, would report zero violations for the wrong reason. Counted here so
   * a passing run can say what it actually saw.
   */
  readonly sanctionedWrites: number;
  /** Empty is the passing state. */
  readonly violations: readonly StatusViolation[];
}

/**
 * Rule `transaction-status-sanction-missing`: the exemption has to point at a real file.
 *
 * A check whose exemption names a file that has been moved or deleted is a check that exempts
 * everything - the failure mode of every allowlist - so the file's absence is itself a violation
 * rather than a silently empty exemption.
 */
function checkSanction(files: readonly SourceFile[]): StatusViolation[] {
  if (files.some((file) => file.path === SANCTIONED_STATUS_FILE)) {
    return [];
  }

  return [
    {
      file: SANCTIONED_STATUS_FILE,
      line: 0,
      rule: STATUS_RULES.missingSanction,
      detail: `the one file allowed to write a payment's status does not exist, so this check would exempt everything - point it at today's writer`,
    },
  ];
}

/**
 * The file with comments replaced by spaces - same length, same line breaks.
 *
 * The same helper the money check has, duplicated on purpose: the two checks are deliberately
 * independent modules (neither can be deleted or moved without the other, and the money module's
 * docblock argues that its own import graph has to stay small and erasable), and twenty lines of
 * comment stripping is a smaller cost than an import from a payments rule into the money rules'
 * internals.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^ \n]/g, ' '));
}

/**
 * The index of the `}` that closes the `{` at `open`, or `-1` if there is not one.
 *
 * Quote-aware, because a brace inside a string is not a brace: the files this scans are full of
 * messages (`\`Payment ${id} failed: ${reason}\``), and a matcher that counted those would end a
 * block early and report a line number nobody could act on.
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;

  for (let index = open; index < text.length; index += 1) {
    const character = text[index] as string;

    if (quote !== undefined) {
      if (character === quote && text[index - 1] !== '\\') {
        quote = undefined;
      }

      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

/** The Prisma methods that can write a row. A read cannot change a status. */
const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert']);

/**
 * Rule `transaction-status-write`: a `data:` block that sets a transaction's `status`.
 *
 * The shape it reads, and why that shape rather than "any `status:` anywhere":
 *
 * - **The model has to be `transaction`.** `auth.service.ts` writes `user.status` in exactly the
 *   same `data: { status: UserStatus.ACTIVE }` form, and a rule that flagged it would be
 *   unusable - which is why the model is part of the pattern rather than assumed.
 * - **The method has to write.** `where: { status: ... }` is how *every* read in this codebase
 *   asks about payments, so the rule looks only inside the argument object of
 *   `create`/`createMany`/`update`/`updateMany`/`upsert`, and only at a `data:` block inside it.
 *   A `findMany` with a status filter, or an assertion *about* a write
 *   (`expect(writes[0]).toEqual({ where, data: { status: ... } })` in a spec), is not a write and
 *   is not reported.
 *
 * What it therefore cannot see, stated rather than discovered: a status smuggled through a
 * variable (`const patch = { status: 'FAILED' }; ...update({ where, data: patch })`), or a status
 * written by a file that reaches Postgres some other way than through this client. Those are the
 * same gaps the money check names about aliases, and they are the price of a check that runs in
 * milliseconds instead of on a type-checked parse.
 */
function checkWriteCalls(file: SourceFile): StatusViolation[] {
  const text = stripComments(file.text);
  const violations: StatusViolation[] = [];

  for (const call of text.matchAll(/\b(\w+)\.(\w+)\s*\(\s*\{/g)) {
    const [pattern, model, method] = call as unknown as [string, string, string];

    if (model !== 'transaction' || !WRITE_METHODS.has(method)) {
      continue;
    }

    const blockOpen = (call.index ?? 0) + pattern.length - 1;
    const blockClose = matchingBrace(text, blockOpen);

    if (blockClose === -1) {
      continue;
    }

    for (const data of text.slice(blockOpen, blockClose).matchAll(/\bdata\s*:\s*\{/g)) {
      const dataOpen = blockOpen + (data.index ?? 0) + data[0].length - 1;
      const dataClose = matchingBrace(text, dataOpen);

      if (dataClose === -1) {
        continue;
      }

      const status = /\bstatus\s*:/.exec(text.slice(dataOpen, dataClose));

      if (status === null) {
        continue;
      }

      violations.push({
        file: file.path,
        line: lineOf(text, dataOpen + status.index),
        rule: STATUS_RULES.write,
        detail: `transaction.${method} writes the status column directly, which bypasses the state machine - call a writer in ${SANCTIONED_STATUS_FILE} (claimForSubmission, recordEnvelope, restoreEnvelope, markFailed, markSuccessful) instead`,
      });
    }
  }

  return violations;
}

/**
 * Rule `transaction-status-sql`: the column written by a statement rather than by the client.
 *
 * The one path the rule above cannot see, because it is the one path that leaves TypeScript: a
 * template handed to `$executeRaw` (or the SQL inside a migration) is a string until Postgres
 * reads it. The pattern is deliberately narrow - `SET status =` - so that prose about the column,
 * or a `WHERE status = 'PROCESSING'`, is not reported as a write.
 */
function checkRawSql(file: SourceFile): StatusViolation[] {
  const text = stripComments(file.text);
  const violations: StatusViolation[] = [];

  for (const match of text.matchAll(/\bset\s+status\s*=/gi)) {
    violations.push({
      file: file.path,
      line: lineOf(text, match.index ?? 0),
      rule: STATUS_RULES.sql,
      detail: `a raw SQL write to the status column, which the state machine cannot guard - use a writer in ${SANCTIONED_STATUS_FILE}, where the compare-and-set lives`,
    });
  }

  return violations;
}

/** One-based line number of a character offset in `text`. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** Whether a path is the one file allowed to write the column. */
function isSanctioned(path: string): boolean {
  return path === SANCTIONED_STATUS_FILE;
}

/**
 * Every rule, over every file - the function the CLI and the spec both call.
 *
 * Pure on purpose: `checkTransactionStatusDiscipline` below does the reading, and this does the
 * judging, so the spec can feed it fabricated sources and prove each rule fires. Sorted by file,
 * then line, then rule, so the output is stable between runs (a CI log that reorders itself is a
 * CI log nobody diffs).
 */
export function findStatusViolations(files: readonly SourceFile[]): StatusViolation[] {
  const violations: StatusViolation[] = [
    ...files
      .filter((file) => !isSanctioned(file.path))
      .flatMap((file) => [...checkWriteCalls(file), ...checkRawSql(file)]),
    ...checkSanction(files),
  ];

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

/**
 * How many status writes the sanctioned file holds.
 *
 * The non-vacuity half of the report: this is what lets a passing run say "and the file this rule
 * exempts really is the one writing the column", rather than passing because nothing anywhere
 * writes it.
 */
export function sanctionedStatusWrites(files: readonly SourceFile[]): number {
  return files
    .filter((file) => isSanctioned(file.path))
    .reduce((total, file) => total + checkWriteCalls(file).length, 0);
}

/** What this check reads: production code and the e2e specs. */
const SCANNED_DIRECTORIES = ['src', 'test'] as const;

/** Generated Prisma output, and build output. */
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
export async function readScanSources(repoRoot: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];

  for (const directory of SCANNED_DIRECTORIES) {
    await collectTypeScript(join(repoRoot, directory), repoRoot, found);
  }

  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** The check as CI runs it: read the repository, judge it, report what is wrong. */
export async function checkTransactionStatusDiscipline(
  repoRoot: string,
): Promise<StatusDisciplineReport> {
  const files = await readScanSources(repoRoot);

  return {
    scanned: files.length,
    sanctionedWrites: sanctionedStatusWrites(files),
    violations: findStatusViolations(files),
  };
}
