import { Amount } from '../../common/money/amount.js';

/**
 * The comparison at the heart of Step 31, as a pure function.
 *
 * Reconciliation asks one question per account: **does what this app's own records say the account
 * holds agree with what the network says it holds?** Everything that makes the question hard - which
 * rows, in what order, how many at a time, what Horizon answered - is the service's business; what
 * makes it *decidable* is here, offline and total, so `reconciliation.spec.ts` can pin every answer
 * without a database or a network.
 *
 * ## What "internal net" is
 *
 * The sum of the money this app has moved *through* USDC for one account: every `SUCCESSFUL`
 * transaction where the user is the recipient, less every `SUCCESSFUL` transaction where the user is
 * the sender. Only `SUCCESSFUL` counts, and that is the whole reason the state machine exists: a
 * `PENDING` or `PROCESSING` payment has not been written to the ledger yet, so Horizon's balance does
 * not reflect it, and counting it here would report a drift that is really just a payment in flight.
 * A `FAILED` payment moved nothing (Horizon never debited it), so it is not counted either.
 *
 * ## What "Horizon balance" is
 *
 * The account's USDC line, exactly as Horizon reports it, or `null` when there is no line (an account
 * the ledger has never seen, or one whose trustline is missing). `null` is read as *zero USDC*, which
 * is the correct reading rather than a missing value: an account with no USDC line can receive no
 * USDC, so if this app's records claim it holds some, that is a real and serious drift.
 *
 * ## Only USDC, deliberately
 *
 * Native XLM is not reconciled. XLM pays fees, is topped up from outside this app (friendbot, a
 * treasury, a human), and is not money the product moves - so its balance is not a claim these
 * records make, and comparing it would page somebody about a funding top-up. The settlement asset is
 * the only thing an internal sum can be expected to predict.
 */

/** Zero, the amount a `null` Horizon balance stands for and the base of every comparison here. */
const ZERO = Amount.fromString('0');

/**
 * Whether an amount is exactly zero.
 *
 * `Amount` exposes `isAtLeast` and `isPositive` but deliberately no `isZero` (Step 23 kept the class
 * one operation wide and Step 25 added the one subtraction that operation needed); zero is therefore
 * expressed as the one amount that is neither greater nor less than it. Written once, here, so the
 * reconciliation code never writes a second spelling of "this agreed".
 */
export function isZeroAmount(amount: Amount): boolean {
  return amount.isAtLeast(ZERO) && ZERO.isAtLeast(amount);
}

/**
 * What one account's comparison found.
 *
 * `drifted` carries the `drift` itself - Horizon less internal - because the *sign* is the first
 * thing an operator asks about: negative means the network holds less than these records claim
 * (money that should be somewhere is not), positive means it holds more (a credit this app did not
 * record, most often an outside deposit). The number goes into the alert; this type only says which
 * of the two answers it is.
 */
export type ReconciliationOutcome =
  | { readonly verdict: 'matched' }
  | { readonly verdict: 'drifted'; readonly drift: Amount };

/**
 * Compares one account's internal net with its Horizon USDC balance.
 *
 * `horizonUsdc` is Horizon's own decimal string, or `null` for "no USDC line" - see this file's
 * docblock for why `null` reads as zero rather than as unknown. `Amount.fromString` parses it: the
 * value arrives as text over HTTP, which is exactly the case `fromString` is for, and it refuses
 * anything that could not be a 7-decimal asset amount rather than guessing.
 */
export function reconcileAccount(
  internalNet: Amount,
  horizonUsdc: string | null,
): ReconciliationOutcome {
  const horizon = horizonUsdc === null ? ZERO : Amount.fromString(horizonUsdc);
  const drift = horizon.minus(internalNet);

  return isZeroAmount(drift) ? { verdict: 'matched' } : { verdict: 'drifted', drift };
}
