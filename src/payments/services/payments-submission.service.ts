import { Injectable, Logger } from '@nestjs/common';
import { Operation, type Keypair, type Transaction } from '@stellar/stellar-sdk';
import { Amount } from '../../common/money/amount.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeedCustodyService } from '../../wallet/custody/seed-custody.service.js';
import {
  UsdcTrustlineService,
  type TrustlineAccountRow,
} from '../../wallet/provisioning/usdc-trustline.js';
import { StellarService } from '../../wallet/stellar/stellar.service.js';
import { triageSubmission } from './submission-triage.js';
import {
  claimForSubmission,
  isTerminal,
  markFailed,
  recordEnvelope,
  restoreEnvelope,
  type RecordedEnvelope,
} from './transaction-status.js';

/**
 * What one submission attempt ended up doing (Step 27), as the answer the caller reports.
 *
 * Five answers, and the two that matter most are the two that change nothing: `deferred` (a
 * transaction is already recorded and may still land, so this attempt did nothing on purpose)
 * and `skipped` (the payment is already resolved, or another attempt claimed it). A submission
 * job that "did nothing" is not a failure - it is this design working - but it is also not
 * silence: every answer is reported with a short `detail` so the job's result says which one it
 * was.
 */
export type SubmissionOutcomeStatus =
  | 'accepted'
  | 'failed'
  | 'skipped'
  | 'deferred'
  | 'superseded';

export interface SubmissionOutcome {
  readonly status: SubmissionOutcomeStatus;
  /** The hash the row holds after this attempt (`null` when it holds none). */
  readonly stellarTxHash: string | null;
  /** The ledger Horizon reported, when it answered. `null` otherwise. */
  readonly ledger: number | null;
  /**
   * A short machine code: the reason that was written to `failureReason` for `failed`, and the
   * name of the condition for every other answer (`status:SUCCESSFUL`, `claimed-elsewhere`,
   * `recorded-transaction-still-valid`). Never free text, never Horizon's prose - see
   * `submission-triage.ts` for why.
   */
  readonly detail: string | null;
}

/**
 * The payment columns this service reads, and nothing else.
 */
interface PaymentRow {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly amount: { toString(): string };
  readonly status: TransactionStatus;
  readonly stellarTxHash: string | null;
  readonly stellarTxSequence: string | null;
  readonly submissionDeadline: Date | null;
}

/**
 * What the locked section did, which is not yet a decision - `submission-triage.ts` makes that
 * from it, outside the lock, where its answers can be acted on without holding a row.
 */
type AttemptOutcome =
  | { readonly kind: 'accepted'; readonly hash: string; readonly ledger: number | null }
  | { readonly kind: 'stopped'; readonly detail: string }
  | {
      readonly kind: 'rejected';
      readonly error: unknown;
      /** Whether this attempt recorded a transaction *over* an earlier record. */
      readonly rebuilt: boolean;
      /** What this attempt recorded, so a restore can compare-and-set on it (`null` if nothing was built). */
      readonly written: RecordedEnvelope | null;
    };

/** The columns every read of a payment in this file asks for. */
const PAYMENT_COLUMNS = {
  id: true,
  senderId: true,
  recipientId: true,
  amount: true,
  status: true,
  stellarTxHash: true,
  stellarTxSequence: true,
  submissionDeadline: true,
} as const;

/** The columns a wallet lookup returns: exactly what custody needs, plus the public key. */
const WALLET_COLUMNS = {
  id: true,
  publicKey: true,
  encryptedSecretKey: true,
  dataKeyArn: true,
} as const;

/**
 * Turns a claimed payment row into a signed, submitted Stellar transaction (Step 27).
 *
 * This is the only code in the app that spends a payment's money, and it is written as a pure
 * function of the row: every attempt re-reads `transactions` and lets the row's own state decide
 * what happens. Nothing is remembered between attempts, nothing is trusted from the queue's
 * payload beyond the transaction id, and no job option can change the outcome - which is what
 * makes "the job ran twice" a question about the *row* rather than about BullMQ's bookkeeping.
 *
 * ## The three writes, and why each is where it is
 *
 * 1. **The claim** - `PENDING` to `PROCESSING`, conditional on the status still being `PENDING`.
 *    One row updated means this attempt owns the payment; zero means another attempt got there
 *    first and this one stops. It is the first write because everything after it is allowed to
 *    be slow.
 * 2. **The record** - the hash, the sequence number and the deadline, written *before* the signed
 *    transaction is handed to Horizon, conditional on the record the attempt started from. A
 *    crash between the two leaves a row that says "this transaction may exist", which is the
 *    only reading that is safe to act on; and the condition is what stops two builds from both
 *    believing they own the record.
 * 3. **The verdict** - `FAILED` with a reason, or the restored record after a superseding
 *    sequence conflict. Both conditional on the status still being `PROCESSING`, so a payment
 *    another attempt has already resolved is never overwritten by a stale conclusion.
 *
 * As of Step 29 none of those writes is *here* any more: each one is a named writer in
 * `transaction-status.ts` (`claimForSubmission`, `recordEnvelope`, `restoreEnvelope`,
 * `markFailed`), which is the only file in the repository allowed to write the `status` column -
 * a property `check-status-discipline.ts` checks on every lint run. This file calls them and
 * decides what their answers mean; the guards and the compare-and-set conditions live with the
 * writers, so there is one place to read the whole state machine rather than one per caller.
 * An attempt to move a payment somewhere the state machine forbids still fails loudly - the
 * guard throws - but it throws from the writer, before the database is touched.
 *
 * ## Key material
 *
 * The seed is opened by `SeedCustodyService` into a `Keypair` that lives in this method's scope
 * for the length of one signed build, and is then out of scope. Nothing in this class logs,
 * returns or error-wraps it: the log lines carry the payment id, the hash and a reason code, and
 * the errors that travel out are the ones custody and the submitter already classified (neither
 * of which carries a seed). "Discard the key" means exactly that and nothing stronger - a
 * JavaScript string cannot be zeroed - and `docs/step-27-proposal.md` says so where the design
 * is recorded.
 *
 * ## What this does not do
 *
 * - **It does not poll.** Horizon answering `submitTransaction` is acceptance, not settlement:
 *   the row stays `PROCESSING` and Step 28 is what turns it into `SUCCESSFUL`.
 * - **It does not re-check the balance or the trustline.** `PaymentsService.create` checked both
 *   at creation, and the network is the authority afterwards - a payment whose balance moved in
 *   between fails on-ledger with a code this step records as a readable reason.
 * - **It does not bump the fee.** A transaction rejected for its fee is dead, and this step's
 *   answer to that is a rebuild (once the fence allows one), not a fee strategy.
 */
@Injectable()
export class PaymentsSubmissionService {
  private readonly logger = new Logger(PaymentsSubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly custody: SeedCustodyService,
    private readonly stellar: StellarService,
    private readonly usdc: UsdcTrustlineService,
  ) {}

  /**
   * Submits the payment `transactionId` names, or reports why it did not.
   *
   * The order is the design, so it is stated once here and not re-derived in the code below:
   *
   * 1. **Read the row.** No row means an orphan job (see below); a resolved status means there is
   *    nothing to do and saying so is the honest answer.
   * 2. **Claim it**, if it is still `PENDING`.
   * 3. **Know the wallets.** A payment whose sender or recipient has no wallet row cannot move
   *    money, and `FAILED` with a reason is a better outcome than retrying forever.
   * 4. **The fence's first half.** A recorded transaction whose deadline has not passed may still
   *    land, so this attempt defers to it and does nothing at all - not even opening the seed.
   * 5. **Open the seed**, *before* taking the account's sequence lock: a KMS round trip inside the
   *    lock would serialise every transaction for that account behind a key fetch (the same
   *    ordering `usdc-trustline.ts` records).
   * 6. **Build, record, submit** - all inside one `withAccount`, so load, build, record and submit
   *    are indivisible for that account's sequence number.
   * 7. **Triage** what happened, outside the lock, and act on it.
   *
   * An orphan job **throws**: a job that names a payment which does not exist is a bug (a
   * rollback that raced the enqueue, a hand-written job, a renamed payload), and acknowledging it
   * would be the "done without being attempted" failure the queue's own discipline forbids.
   */
  async submit(transactionId: string): Promise<SubmissionOutcome> {
    const payment = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      select: PAYMENT_COLUMNS,
    });

    if (payment === null) {
      throw new Error(
        `Payment ${transactionId} does not exist, so there is nothing to submit - this job has no row`,
      );
    }

    if (isTerminal(payment.status)) {
      // Already answered. Nothing about this payment may change any more, and a second
      // submission would be a second debit attempt.
      return outcome('skipped', payment.stellarTxHash, null, `status:${payment.status}`);
    }

    if (payment.status === TransactionStatus.PENDING) {
      // The claim goes through the state machine's writer (Step 29) - the only code allowed to
      // write the `status` column - which keeps the guard and the compare-and-set condition with
      // the transition they belong to rather than in every caller.
      const claimed = await claimForSubmission(this.prisma, transactionId);

      if (!claimed) {
        // Another attempt claimed it between the read and the write. Whichever attempt wins, one
        // of them owns the payment - and the loser must not build anything at all.
        return outcome('skipped', payment.stellarTxHash, null, 'claimed-elsewhere');
      }
    }

    const wallets = await this.walletsFor(payment);

    if (wallets.sender === null) {
      // Impossible on the creation path (it locks the sender's wallet row), so it means the row
      // was deleted out from under a committed payment. There is no key to sign with.
      return this.fail(transactionId, 'wallet-missing:sender');
    }

    if (wallets.recipient === null) {
      // A payment to an account that cannot exist on the network. Nothing this job can do about
      // it, and it is not going to become true later.
      return this.fail(transactionId, 'wallet-missing:recipient');
    }

    const recorded = recordedTransactionOf(payment, transactionId);

    if (recorded !== null && recorded.deadline.getTime() > Date.now()) {
      // The fence, first half. A transaction is recorded and its deadline has not passed, so it
      // may still land: building another one now would be a second live transaction for one
      // payment. (This is also why a retry after an unanswered submission is cheap: it stops
      // here, inside a millisecond, instead of reaching Horizon.)
      return outcome('deferred', recorded.hash, null, 'recorded-transaction-still-valid');
    }

    const keypairInput = wallets.sender;
    let attempt: AttemptOutcome;

    try {
      /**
       * Opening the seed and taking the account's sequence lock are two different services, and
       * both can fail on their own: custody with an outage or an unopenable blob, the lock with a
       * Horizon that cannot be reached. Wrapping them together is what puts every one of those
       * failures through the triage, which is the only thing that decides whether a failure is a
       * verdict on the payment or a reason to try again.
       */
      const keypair = await this.custody.openSeed(keypairInput);

      attempt = await this.attempt(transactionId, {
        payment,
        sender: keypairInput,
        recipient: wallets.recipient,
        recorded,
        keypair,
      });
    } catch (error) {
      // Nothing was built by *this* attempt at this point, so there is no record to restore and
      // nothing to report as rebuilt: both flags stay false, and the triage reads them as "no
      // transaction of ours is in play".
      attempt = { kind: 'rejected', error, rebuilt: false, written: null };
    }

    return this.act(transactionId, payment, recorded, attempt);
  }

  /**
   * The locked section: the fence's second half, then build, record and submit.
   *
   * Everything here happens inside `StellarService.withAccount`, so for this sender's account the
   * loaded sequence number, the build that consumes it and the submission that spends it are one
   * indivisible step. That is the property the whole step rests on: two builds from one snapshot
   * would be two transactions carrying the same sequence number, and only one of them could ever
   * land.
   */
  private async attempt(
    transactionId: string,
    input: {
      readonly payment: PaymentRow;
      readonly sender: TrustlineAccountRow;
      readonly recipient: TrustlineAccountRow;
      readonly recorded: RecordedEnvelope | null;
      readonly keypair: Keypair;
    },
  ): Promise<AttemptOutcome> {
    const { payment, sender, recipient, recorded, keypair } = input;

    return this.stellar.withAccount(
      sender.publicKey,
      async (session): Promise<AttemptOutcome> => {
        if (recorded !== null) {
          const comparison = compareSequenceNumbers(session.sequenceNumber, recorded.sequence);

          if (comparison === 'ahead') {
            // The fence, second half: the recorded transaction consumed the sequence, so it is on
            // the network (or in flight) and there is nothing to rebuild. Stopping here is this
            // job doing its job - Step 28's poll is what turns that transaction into a settlement.
            return { kind: 'stopped', detail: 'recorded-transaction-consumed-the-sequence' };
          }

          if (comparison === 'behind') {
            // Horizon reports a sequence *below* the one a recorded transaction used. Sequences
            // only move forwards, so this is not a state to reason about: it is retried, and the
            // next attempt reads both the row and Horizon again.
            throw new Error(
              `Horizon reports sequence ${session.sequenceNumber} for ${sender.publicKey}, behind the ${recorded.sequence} this payment recorded`,
            );
          }
        }

        // The number the transaction will carry: the session's next sequence, which `build`
        // consumes. Taken *before* the build, because that is the value the ledger will use.
        const sequence = session.sequenceNumber;

        const transaction = session.build([
          Operation.payment({
            destination: recipient.publicKey,
            asset: this.usdc.asset(),
            // The 7-decimal fixed-point string - the form the ledger uses, and the form
            // `common/money` documents as the one this SDK call needs. No JS number is involved
            // anywhere on this path.
            amount: Amount.fromDatabase(payment.amount).toStellarAmount(),
          }),
        ]);

        transaction.sign(keypair);

        /**
         * After signing, deliberately. The hash is taken over the signature base, so signing
         * changes it: the value recorded here is the hash of the envelope Horizon will receive -
         * the value it echoes back, and the value an operator can look up.
         */
        const hash = Buffer.from(transaction.hash()).toString('hex');

        const written = { hash, sequence, deadline: deadlineOf(transaction, transactionId) };
        const stored = await recordEnvelope(this.prisma, transactionId, recorded, written);

        if (!stored) {
          // The record changed between the read and the write, which means another attempt is
          // working on this payment. Submitting anyway would be exactly the second live
          // transaction this design exists to prevent.
          throw new Error(
            `Payment ${transactionId} was recorded by another attempt while a transaction was being built for it`,
          );
        }

        try {
          const submitted = await this.stellar.submitTransaction(transaction);

          if (submitted.hash.toLowerCase() !== hash) {
            // Horizon answered about a different envelope than the one this attempt recorded. Not
            // a state to interpret: this error is not one the triage classifies, so it retries,
            // and the next attempt reads the row again.
            throw new Error(
              `Horizon answered with hash ${submitted.hash} for a transaction recorded as ${hash}`,
            );
          }

          this.logger.log(
            `Payment ${transactionId} submitted as ${hash} (ledger ${submitted.ledger ?? 'unreported'})`,
          );

          return { kind: 'accepted', hash, ledger: submitted.ledger ?? null };
        } catch (error) {
          // The transaction was built and recorded, so the triage is told both: `rebuilt` is what
          // makes `tx_bad_seq` mean "the recorded transaction landed instead", and `written` is
          // what a restore compares-and-sets on.
          return { kind: 'rejected', error, rebuilt: recorded !== null, written };
        }
      },
    );
  }

  /**
   * Acts on what the locked section did, outside the lock.
   *
   * The lock is released before anything here runs, deliberately: deciding that a payment failed
   * and writing that down needs no hold on the sender's sequence number, and holding one while a
   * second write is issued would serialise the account behind bookkeeping.
   *
   * `retry` and `rebuild` both **rethrow the original error**, so BullMQ counts an attempt and the
   * job's failure log carries the classification that failed. `rebuild` in particular is not an
   * action performed here: rebuilding needs a *fresh* sequence load, so it happens on the next
   * attempt - where the fence decides whether building one is safe at all.
   */
  private async act(
    transactionId: string,
    payment: PaymentRow,
    recorded: RecordedEnvelope | null,
    attempt: AttemptOutcome,
  ): Promise<SubmissionOutcome> {
    if (attempt.kind === 'accepted') {
      // Accepted, not settled: the row keeps the hash it recorded and stays `PROCESSING` until
      // Step 28's poll sees the transaction in a closed ledger.
      return outcome('accepted', attempt.hash, attempt.ledger, null);
    }

    if (attempt.kind === 'stopped') {
      return outcome('deferred', recorded?.hash ?? null, null, attempt.detail);
    }

    const intent = triageSubmission({
      accepted: false,
      error: attempt.error,
      rebuilt: attempt.rebuilt,
      // Read from the row as it was *before* this attempt, which is what the triage's custody rule
      // turns on: a failure to open the seed is terminal only when nothing was ever recorded.
      hadRecord: payment.stellarTxHash !== null,
    });

    switch (intent.kind) {
      case 'failed':
        return this.fail(transactionId, intent.reason);

      case 'superseded': {
        if (recorded === null || attempt.written === null) {
          // Unreachable by construction - the triage answers `superseded` only when this attempt
          // rebuilt over a record, and a rebuild implies both halves exist - but stated rather
          // than assumed, and thrown rather than written: a restore without both halves would
          // fabricate a record.
          throw new Error(
            `Payment ${transactionId} was reported as superseded without a record to restore`,
          );
        }

        const restored = await restoreEnvelope(
          this.prisma,
          transactionId,
          attempt.written,
          recorded,
        );

        if (!restored) {
          // Neither restored nor advanced: a state a human needs to see, and a retry re-reads the
          // row and decides again.
          throw new Error(
            `Payment ${transactionId} could not be restored to its recorded transaction: the row moved while the restore was in flight`,
          );
        }

        this.logger.warn(
          `Payment ${transactionId} is superseded by its recorded transaction ${recorded.hash} (tx_bad_seq)`,
        );

        return outcome('superseded', recorded.hash, null, 'tx_bad_seq');
      }

      case 'retry':
      case 'rebuild':
        // Logged because a retry that is never explained looks like a flake, and the difference
        // between these two - a dead transaction versus a failure with no verdict - is exactly
        // what an operator reading a failed job needs to know.
        this.logger.warn(
          `Payment ${transactionId} needs another attempt: ${intent.kind} (${intent.detail})`,
        );

        throw attempt.error;

      default:
        throw new Error(
          `Payment ${transactionId}: the triage answered ${intent.kind} for a failed attempt`,
        );
    }
  }

  /**
   * Records the payment as failed, with the reason, and answers.
   *
   * The write is `markFailed` in `transaction-status.ts` (Step 29) - the state machine's guard and
   * its compare-and-set condition - and what this method adds is what a lost race means *here*:
   * the row stopped being `PROCESSING` before the write landed, so somebody else has already
   * answered the payment and this attempt must not report a failure the row does not show.
   *
   * The hash the row holds is deliberately left in place by the writer: it names a transaction
   * Horizon refused, which is worth keeping as the fingerprint of the attempt.
   */
  private async fail(transactionId: string, reason: string): Promise<SubmissionOutcome> {
    const failed = await markFailed(this.prisma, transactionId, reason);

    if (!failed) {
      return outcome('skipped', null, null, 'not-processing');
    }

    this.logger.warn(`Payment ${transactionId} failed: ${reason}`);

    return outcome('failed', null, null, reason);
  }

  /** Both wallets a payment touches, read together: two independent lookups, no ordering needed. */
  private async walletsFor(payment: PaymentRow): Promise<{
    readonly sender: TrustlineAccountRow | null;
    readonly recipient: TrustlineAccountRow | null;
  }> {
    const [sender, recipient] = await Promise.all([
      this.walletFor(payment.senderId),
      this.walletFor(payment.recipientId),
    ]);

    return { sender, recipient };
  }

  /** The account row for a user, or `null` when that user has no wallet. */
  private async walletFor(userId: string): Promise<TrustlineAccountRow | null> {
    return this.prisma.stellarAccount.findUnique({
      where: { userId },
      select: WALLET_COLUMNS,
    });
  }
}

/**
 * One submission outcome, with the four fields every answer carries spelled out once.
 *
 * A function rather than five object literals so the shape cannot drift between answers: a reader
 * comparing `accepted` with `deferred` in a log sees the same fields, and adding one is a single
 * edit.
 */
function outcome(
  status: SubmissionOutcomeStatus,
  stellarTxHash: string | null,
  ledger: number | null,
  detail: string | null,
): SubmissionOutcome {
  return { status, stellarTxHash, ledger, detail };
}

/**
 * The transaction the row records, if any.
 *
 * A hash without a sequence number or without a deadline is thrown on rather than returned as a
 * half-populated record: the columns are written in one statement, so a row with one and not the
 * others was not written by this code, and guessing what it means would be guessing about money.
 * The error is not a classified submission failure, so it retries - and a retry re-reads the row,
 * which is what an operator repairing it needs.
 */
function recordedTransactionOf(
  payment: PaymentRow,
  transactionId: string,
): RecordedEnvelope | null {
  const { stellarTxHash, stellarTxSequence, submissionDeadline } = payment;

  if (stellarTxHash === null) {
    return null;
  }

  if (stellarTxSequence === null || submissionDeadline === null) {
    throw new Error(
      `Payment ${transactionId} records a transaction hash without the sequence number or the deadline that go with it`,
    );
  }

  return { hash: stellarTxHash, sequence: stellarTxSequence, deadline: submissionDeadline };
}

/**
 * Compares the sequence number Horizon just reported with the one the row recorded, as integers.
 *
 * `BigInt`, never `Number`: a Stellar sequence is an int64 and `Number` silently rounds above
 * 2^53 - the argument `StellarAccountSession` records for keeping sequence numbers as strings in
 * the first place. Both values arrive as decimal digit strings, and a string that is not one makes
 * `BigInt` throw, which is the right outcome: an unparseable sequence is not something to guess
 * about, and the error is not a classified submission failure, so it retries.
 *
 * The three answers, and why each is its own case:
 *
 * - `equal` - the recorded transaction never consumed this sequence, so a rebuild is legitimate
 *   (subject to the deadline half of the fence).
 * - `ahead` - the sequence moved past it, so the recorded transaction landed. Nothing to rebuild.
 * - `behind` - Horizon reported a number below a recorded one, which a monotonic sequence cannot
 *   do. Not a state to reason about; retried.
 */
export function compareSequenceNumbers(
  fresh: string,
  recorded: string,
): 'equal' | 'ahead' | 'behind' {
  const freshValue = parseSequence(fresh);
  const recordedValue = parseSequence(recorded);

  if (freshValue === recordedValue) {
    return 'equal';
  }

  return freshValue > recordedValue ? 'ahead' : 'behind';
}

/**
 * A sequence number as an integer, or a refusal.
 *
 * The digits-only check is not decoration: `BigInt('')` is `0n` rather than an error, so an empty
 * string would silently compare as "behind everything" - a reading this code would act on. Digits
 * only is the whole of what a sequence number can be, so anything else is refused, and the refusal
 * is not a classified submission failure: it retries, and the next attempt re-reads the row.
 */
function parseSequence(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`"${value}" is not a sequence number (digits only)`);
  }

  return BigInt(value);
}

/**
 * When the built transaction stops being valid: its own `maxTime`, as a `Date`.
 *
 * Taken from the transaction rather than from a constant, so the fence cannot drift from the thing
 * it fences: what the row records is exactly the deadline the network enforces, and a change to
 * the session's timeout changes both at once.
 *
 * A transaction with no time bounds is a programming error rather than a fact about the world -
 * `StellarAccountSession.build` always sets one - and it is thrown as such, because a transaction
 * that never expires is the one shape this design cannot reason about.
 */
function deadlineOf(transaction: Transaction, transactionId: string): Date {
  const maxTime = transaction.timeBounds?.maxTime;

  if (maxTime === undefined) {
    throw new Error(
      `The transaction built for payment ${transactionId} has no maximum time, so there is no deadline to record`,
    );
  }

  // Unix seconds, which the SDK writes as a string. `Number` is exact for any timestamp this
  // century; this is a clock reading, not an amount.
  return new Date(Number(maxTime) * 1000);
}
