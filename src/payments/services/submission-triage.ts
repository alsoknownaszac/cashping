import { SecretEnvelopeError } from '../../wallet/custody/secret-envelope.js';
import { KeyCustodyUnavailableError, KmsKeyNotFoundError } from '../../wallet/custody/key-wrapper.js';
import {
  StellarSubmissionRejectedError,
  StellarSubmissionUnavailableError,
} from '../../wallet/stellar/transaction-submitter.js';

/**
 * What a submission attempt decided (Step 27).
 *
 * Five answers, and every one of them is a decision this codebase has to be able to defend to
 * somebody looking at a payment that did or did not move money:
 *
 * - `accepted` - Horizon took the transaction. The row keeps its hash and stays `PROCESSING`,
 *   because accepted is not the same as closed: Step 28's poll turns it into `SUCCESSFUL`.
 * - `retry` - no verdict was reached, or the verdict is not one this step may act on. The row is
 *   left alone (it keeps whatever it recorded) and the error travels out of the handler so
 *   BullMQ's attempt count prices it.
 * - `rebuild` - the recorded transaction is provably dead (`tx_too_late`,
 *   `tx_insufficient_fee`), so a fresh one is legitimate *if the fence permits it*. That "if"
 *   belongs to `PaymentsSubmissionService`, because it needs the clock and the row.
 * - `superseded` - the transaction this attempt built was rejected as a sequence conflict,
 *   which means the *previously recorded* transaction is the one that landed. Restore the
 *   record, stop.
 * - `failed` - a definitive no. The row becomes `FAILED` with a short reason.
 *
 * ## The two prefixes, and what each one promises (Step 28's audit of Step 27's names)
 *
 * A reason is written with one of two prefixes, and the pair is what a reader - Step 30's
 * responses, Step 41's reconciliation - has to be able to trust:
 *
 * - `landed-unsuccessful:<code>` - a ledger closed the transaction and the money did not move.
 * - `submission-rejected:<code>` - the submission was refused and no ledger ever saw it.
 *
 * Which one a rejection earns is decided by the code alone, and never by *where* the app learned
 * it. Step 28's real-network run measured the fact that settles the question: Horizon's
 * `submitTransaction` blocks until the ledger closes the transaction, so the `tx_failed` (or
 * `op_*`) code a submission is refused with, and the same code a later poll reads back off the
 * record, describe one event. Step 27's original `submission-rejected:<op code>` named the second
 * while reporting the first; `landedPrefixFor` is the correction, and
 * `docs/step-27-proposal.md` §4 and `docs/step-28-29-proposal.md` §6 record it.
 */
export type SubmissionIntent =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'retry'; readonly detail: string }
  | { readonly kind: 'rebuild'; readonly detail: string }
  | { readonly kind: 'superseded'; readonly detail: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** What happened on one attempt, in the terms the triage needs. */
export interface SubmissionReport {
  /** Horizon accepted it. Nothing else in this object is read when `true`. */
  readonly accepted: boolean;
  /** What the attempt threw, when it did not finish. */
  readonly error?: unknown;
  /**
   * Whether this attempt built a transaction and recorded it *over* an earlier record.
   *
   * The flag exists for one row of the table: `tx_bad_seq` means opposite things depending on
   * it. On a rebuild it means the transaction that was already recorded landed in the gap
   * between the fresh load and the submit, so the old record is the truth (`superseded`). On a
   * first build it means something else consumed the sequence, and a fresh load will produce a
   * sequence that works (`retry`).
   */
  readonly rebuilt?: boolean;
  /**
   * Whether a transaction was already recorded for this payment before this attempt.
   *
   * The second row the table needs it for is key custody: a failure to open the seed is
   * terminal only when there is nothing recorded. With a record, the recorded transaction's
   * fate is unknown, and concluding anything about it from a key problem would be inventing
   * information.
   */
  readonly hadRecord?: boolean;
}

/**
 * Horizon's transaction-level codes for "this transaction can never land".
 *
 * Both are dead transactions rather than refusals of the *payment*: the deadline in the
 * transaction's own time bounds has passed, or the fee offered is below the network's. A fresh
 * transaction is the answer, which is why these two lead to `rebuild` rather than `failed` -
 * and why the fence, not this function, decides whether building one now is safe.
 */
const REBUILDABLE_TRANSACTION_CODES = ['tx_too_late', 'tx_insufficient_fee'] as const;

/**
 * Operation-level codes that mean the money provably did not move, and will not on a retry.
 *
 * The list is deliberately short and explicit rather than "anything Horizon says at the
 * operation level": a code that is not here is a `retry`, so the cost of a missing entry is a
 * few wasted attempts while the cost of a wrong one is a payment reported as failed that might
 * have succeeded. That asymmetry is why the fallback is conservative.
 *
 * - `op_underfunded` - the sender's balance moved after the overdraft check.
 * - `op_low_reserve` - the sender cannot spend down to the account's reserve.
 * - `op_no_trust`, `op_src_no_trust` - a trustline this payment needs does not exist.
 * - `op_not_authorized` - the trustline exists but the issuer has not authorised it.
 * - `op_no_destination` - the recipient account does not exist on the network.
 * - `op_malformed` - the operation cannot be interpreted (a bug, but not one a retry fixes).
 *
 * A code from this list is the `failed` half of the vocabulary: its reason is written
 * `landed-unsuccessful:<op code>`, because every operation-level code arrives framed in a
 * `tx_failed` result - which is a result a *closed* transaction earns, at the cost of its fee and
 * its sequence (Step 28's measurement upstream in this file's docblock).
 */
export const PERMANENT_OPERATION_CODES = [
  'op_underfunded',
  'op_low_reserve',
  'op_no_trust',
  'op_src_no_trust',
  'op_not_authorized',
  'op_no_destination',
  'op_malformed',
] as const;

/**
 * Horizon's transaction-level codes for "no ledger will ever close this transaction".
 *
 * The reservation the vocabulary needs, written as data rather than as a convention: these are
 * the codes that earn `submission-rejected:`, and a code outside this list and outside the
 * operation level does not earn it. Each one is a refusal *about the envelope* rather than a
 * verdict on it, and each names what the network refused to accept:
 *
 * - `tx_bad_seq` - the sequence number is not the one the source account is on.
 * - `tx_too_late` - the time bounds have already passed; nothing will include it.
 * - `tx_malformed` - the envelope cannot be interpreted at all.
 * - `tx_insufficient_fee` - the offered fee is below the network's floor.
 * - `tx_bad_auth` - the signature does not match what the envelope claims to be.
 * - `tx_no_source_account` - the source account does not exist on the network.
 * - `tx_insufficient_balance` - the source cannot cover the fee.
 * - `tx_internal_error` - Horizon's own submitter failed; the envelope was not judged.
 *
 * The list is deliberately explicit for the same reason `PERMANENT_OPERATION_CODES` is: its cost
 * of being wrong is asymmetric. A missing entry costs a prefix (the code retries and the reader
 * sees `unknown:`), while a wrong entry tells a reader that a hash never reached a ledger - and a
 * hash a reader believes was never in a ledger is a hash somebody may feel safe spending past.
 */
export const NEVER_LANDED_TRANSACTION_CODES = [
  'tx_bad_seq',
  'tx_too_late',
  'tx_malformed',
  'tx_insufficient_fee',
  'tx_bad_auth',
  'tx_no_source_account',
  'tx_insufficient_balance',
  'tx_internal_error',
] as const;

/**
 * What one submission failure means, as a pure function of the failure and two facts about the
 * attempt.
 *
 * Pure and dependency-free on purpose: the decisions are the interesting part of Step 27, and a
 * decision reachable only through a KMS client, a Horizon socket and a locked Postgres row is a
 * decision nobody can test exhaustively. Everything that needs the world - the clock, the row,
 * the lock - stays in `PaymentsSubmissionService`, which calls this and then acts on the answer.
 *
 * ## The default is `retry`, and that is the design
 *
 * Three of the five answers are "do not conclude anything", and every error this function does
 * not recognise lands in one of them. A submission whose fate is unknown must never be recorded
 * as a payment that did not move: `StellarSubmissionUnavailableError` is explicit that a timeout
 * and a connection that died after Horizon committed are the same exception, and the safe
 * reading of it is "it may have". Retrying costs an attempt; concluding wrongly costs money.
 */
export function triageSubmission(report: SubmissionReport): SubmissionIntent {
  if (report.accepted) {
    return { kind: 'accepted' };
  }

  const error = report.error;

  if (error instanceof SecretEnvelopeError) {
    return classifySecretEnvelope(error, report.hadRecord ?? false);
  }

  if (error instanceof KeyCustodyUnavailableError || error instanceof KmsKeyNotFoundError) {
    // An outage, or a master key that does not resolve in this deployment. Neither is a verdict
    // on a payment, and marking one FAILED because a deploy was wrong would destroy a payment
    // for an operational mistake.
    return { kind: 'retry', detail: `custody:${describe(error)}` };
  }

  if (error instanceof StellarSubmissionRejectedError) {
    return classifyRejection(error, report.rebuilt ?? false);
  }

  if (error instanceof StellarSubmissionUnavailableError) {
    // The transaction's fate is unknown - it may have landed. The row is left exactly as it is,
    // which is what makes a later attempt defer to it rather than build a second one.
    return { kind: 'retry', detail: `submission:${error.detail}` };
  }

  return { kind: 'retry', detail: `unknown:${describe(error)}` };
}

/**
 * A stored secret that cannot be opened: a fact about the data, not about availability.
 *
 * Terminal only when there is nothing recorded. This error is raised while *opening* the seed,
 * which happens before any transaction exists - so with no record there is nothing to be
 * confused about and the payment cannot proceed. With a record, the recorded transaction may be
 * in a ledger, and a key problem says nothing about that: the attempt retries and the row keeps
 * what it has.
 */
function classifySecretEnvelope(error: SecretEnvelopeError, hadRecord: boolean): SubmissionIntent {
  const reason = `secret-envelope:${error.reason}`;

  return hadRecord ? { kind: 'retry', detail: reason } : { kind: 'failed', reason };
}

/** Horizon answered *about* the transaction: which answer it is decides what may happen next. */
function classifyRejection(
  error: StellarSubmissionRejectedError,
  rebuilt: boolean,
): SubmissionIntent {
  const { transactionCode, operationCodes } = error;
  // Every code reachable before the operation-level search below is in
  // `NEVER_LANDED_TRANSACTION_CODES`: a sequence conflict and both dead-transaction codes are
  // refusals *about* the envelope, so the name is built once rather than spelled per branch.
  const refusedSubmission = `submission-rejected:${transactionCode}`;

  if (transactionCode === 'tx_bad_seq') {
    return rebuilt
      ? { kind: 'superseded', detail: refusedSubmission }
      : { kind: 'retry', detail: refusedSubmission };
  }

  if (REBUILDABLE_TRANSACTION_CODES.some((code) => code === transactionCode)) {
    return { kind: 'rebuild', detail: refusedSubmission };
  }

  const permanent = operationCodes.find((code) =>
    PERMANENT_OPERATION_CODES.some((known) => known === code),
  );

  if (permanent !== undefined) {
    // A `failed` verdict, and the prefix the poller would have written for the same transaction:
    // an operation code is a landed failure by construction, whatever path learned it.
    return { kind: 'failed', reason: `landed-unsuccessful:${permanent}` };
  }

  // Nothing here is a statement about money that this step is willing to make permanent, but the
  // *name* is still settled by the code: `tx_failed` is closed-and-failed, a code in
  // `NEVER_LANDED_TRANSACTION_CODES` was refused with no ledger involved, and anything else earns
  // no prefix at all rather than borrowing a claim.
  const prefix = landedPrefixFor(transactionCode);

  return {
    kind: 'retry',
    detail: prefix === null ? `unknown:${transactionCode}` : `${prefix}:${transactionCode}`,
  };
}

/**
 * The prefix a Horizon transaction code earns in `failure_reason`, or `null` when the code is in
 * neither vocabulary (Step 28's unification of Step 27's names).
 *
 * Two codes, two stories, and both stories are about the ledger rather than about the caller:
 *
 * - `tx_failed` - a transaction is *closed* to earn this result, at the cost of its fee and its
 *   sequence, so the ledger has it and the money did not move: `landed-unsuccessful`.
 * - A code in `NEVER_LANDED_TRANSACTION_CODES` - the submission was refused with no ledger
 *   involved: `submission-rejected`.
 *
 * `null` for anything else, deliberately. An unrecognised code is not evidence of either story,
 * and guessing is the one mistake here with a money-shaped consequence: a reader who believes a
 * hash was never in a ledger may treat it as safe to build past. The caller's fallback is the
 * `unknown:` detail, which asks a human to look.
 */
function landedPrefixFor(
  transactionCode: string,
): 'landed-unsuccessful' | 'submission-rejected' | null {
  if (transactionCode === 'tx_failed') {
    return 'landed-unsuccessful';
  }

  if (NEVER_LANDED_TRANSACTION_CODES.some((code) => code === transactionCode)) {
    return 'submission-rejected';
  }

  return null;
}

/**
 * A short, non-sensitive name for an error, for the `detail` of a retry.
 *
 * Never the message: messages from AWS and from Horizon carry URLs, response bodies and account
 * ids, and a retry's detail ends up in a log line. The class name is enough to tell an operator
 * which system said no, and the attempt's exception - logged by the processor - carries the
 * rest.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
