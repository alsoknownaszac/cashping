import type * as Checker from './status-discipline.js';

/**
 * `npm run lint:status` - Step 29's status rule over this repository, as a lint step.
 *
 * The same division of labour as `lint:money`, and for the same reason: `status-discipline.spec.ts`
 * asserts the rule *works* (against fabricated violations) and that today's repository is clean,
 * while this is the gate that `npm run lint` - and therefore CI - runs on every future change. A
 * rule enforced only by a test that a later commit can delete is a comment with extra steps.
 *
 * What it protects is Step 29's third sentence: the state machine in
 * `src/payments/services/transaction-status.ts` is the only code that writes a payment's `status`,
 * and that is a property of the *repository*, not of the service that happens to call it today. A
 * week from now, someone resolving a support ticket will want to "just set the status back to
 * PENDING so the job retries" - and this is the check that makes that a failed lint with a
 * `file:line` instead of a row that no writer can explain.
 *
 * ## Why this runs TypeScript directly, and why the import is written oddly
 *
 * Node 24 strips types natively - `node src/payments/check-status-discipline.ts`, no flag - so the
 * check needs no build step, no `ts-node` and no extra dependency, which is what a lint command
 * has to be to stay worth running on every commit.
 *
 * The cost is the line below. The two resolvers disagree about extensions: Node's ESM loader
 * requires the file that exists (`./status-discipline.ts`, and it does *not* rewrite a `.js`
 * specifier the way `tsc` does), while `tsc` with `module: nodenext` requires `.js` in a specifier
 * unless `allowImportingTsExtensions` is set, which would be a change to the build for the sake of
 * one script. A specifier computed at runtime is the one form both accept: the `import type` line
 * gives TypeScript the types off the real module, and the `import()` call gives Node the path it
 * insists on.
 *
 * One more thing to know if this file is ever edited: type stripping erases types but does not
 * *transform* syntax, so Node cannot load a module that uses an `enum`, a `namespace` or a
 * constructor parameter property. `status-discipline.ts` uses none - which is also why it spells
 * the four status names as a `const` array instead of importing the generated Prisma enum, and why
 * its spec asserts that the array and the enum still agree.
 *
 * Exits 1 with one line per violation, in the format `file:line  [rule] what is wrong and what to
 * write instead`, so a CI log is enough to fix it without opening the checker.
 */
const checker = (await import(
  new URL('./status-discipline.ts', import.meta.url).href
)) as typeof Checker;

const { scanned, sanctionedWrites, violations } =
  await checker.checkTransactionStatusDiscipline(process.cwd());

if (violations.length === 0) {
  console.log(
    `Status discipline: ${scanned} files scanned, ${sanctionedWrites} status writes in the sanctioned writer, 0 violations`,
  );
  process.exit(0);
}

console.error(`Status discipline: ${violations.length} violation(s) in ${scanned} scanned files\n`);

for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.detail}`);
}

console.error(
  '\nThe rule, and the state machine it protects, are in src/payments/services/transaction-status.ts',
);
console.error('The scan itself, and what it cannot see, is in src/payments/status-discipline.ts');
process.exit(1);
