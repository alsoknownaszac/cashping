import type * as Checker from './money-discipline.js';

/**
 * `npm run lint:money` - Step 23's money rules over this repository, as a lint step.
 *
 * A script rather than a vitest assertion, because the two are not interchangeable:
 * `money-discipline.spec.ts` asserts the rules *work* (with fabricated violations) and
 * that today's repository is clean, while this is the gate that `npm run lint` - and
 * therefore CI - runs on every future change. A rule enforced only by a test that a
 * later commit can delete is a comment with extra steps.
 *
 * ## Why this runs TypeScript directly, and why the import is written oddly
 *
 * Node 24 strips types natively - `node src/common/money/check-money-discipline.ts`,
 * no flag, verified on 24.14.1 - so the check needs no build step, no `ts-node` and no
 * extra dependency, which is what a lint command has to be to stay worth running on
 * every commit.
 *
 * The cost is the line below. The two resolvers disagree about extensions: Node's ESM
 * loader requires the file that exists (`./money-discipline.ts`, and it does *not*
 * rewrite a `.js` specifier the way `tsc` does), while `tsc` with `module: nodenext`
 * requires `.js` in a specifier unless `allowImportingTsExtensions` is set, which would
 * be a change to the build for the sake of one script. A specifier computed at runtime
 * is the one form both accept: the `import type` line gives TypeScript the types off
 * the real module, and the `import()` call gives Node the path it insists on.
 *
 * One more thing to know if this file is ever edited: type stripping erases types but
 * does not *transform* syntax, so Node cannot load a module that uses an `enum`, a
 * `namespace` or a constructor parameter property. `money-discipline.ts` uses none, and
 * deliberately does not import `amount.ts` (which does, for its private `Decimal`), so
 * keep the imports here small and erasable.
 *
 * Exits 1 with one line per violation, in the format `file:line  [rule] what is wrong
 * and what to write instead`, so a CI log is enough to fix it without opening the
 * checker.
 */
const checker = (await import(
  new URL('./money-discipline.ts', import.meta.url).href
)) as typeof Checker;

const { scanned, violations } = await checker.checkMoneyDiscipline(process.cwd());

if (violations.length === 0) {
  console.log(`Money discipline: ${scanned} files scanned, 0 violations`);
  process.exit(0);
}

console.error(`Money discipline: ${violations.length} violation(s) in ${scanned} scanned files\n`);

for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.detail}`);
}

console.error('\nThe rules, and the reason for each, are in src/common/money/money-discipline.ts');
process.exit(1);
