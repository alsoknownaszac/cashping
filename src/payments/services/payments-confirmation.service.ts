import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { Amount } from '../../common/money/amount.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StellarService } from '../../wallet/stellar/stellar.service.js';
import { triageConfirmation, type ConfirmationDecision } from './confirmation-triage.js';
import { markFailed, markSuccessful } from './transaction-status.js';

/**
 * The numbers one sweep reports, which is also the job's stored result.
 *
 * Counted rather than summarised into a word, because these are the numbers an operator needs to
 * tell "quiet" from "broken": `polled > 0` with everything `waiting` is a normal minute on a slow
 * network, `unresolved` with `polled` is a Horizon that is not answering, and `stuckWithoutHash`
 * is the case nothing in this step can fix - see §5 of the step's proposal.
 */
export interface ConfirmationSweepResult {
  /** Rows whose hash was looked up this tick. */
  readonly polled: number;
  /** Rows this tick moved to `SUCCESSFUL`. */
  readonly confirmed: number;
  /** Rows this tick moved to `FAILED`. */
  readonly failed: number;
  /** Rows Horizon has no record of yet, still inside their validity window. */
  readonly waiting: number;
  /** Rows nothing may be concluded about (Horizon did not answer, or no deadline is recorded). */
  readonly unresolved: number;
  /**
   * `PROCESSING` rows with *no* hash, older than the reporting window: a claim that never
   * recorded an envelope. Reported, never written - a poller has no hash to poll.
   */
  readonly stuckWithoutHash: number;
}

/**
 * The same counters *while a sweep is still running*.
 *
 * `ConfirmationSweepResult` is the shape a sweep has once it is over - the value handed back as the
 * job's result - and its fields are `readonly` because a caller reading a result must not be able
 * to edit what it read. The counters have to be written while the rows are worked through, so the
 * tally maps those same fields back to writable rather than typing the six names out a second time
 * (a second list is a second place for a counter to be forgotten). It never leaves this class:
 * `sweep` returns it as the `readonly` shape, which TypeScript accepts, because a `readonly`
 * modifier is not part of a type's identity.
 */
type SweepTally = { -readonly [Key in keyof ConfirmationSweepResult]: ConfirmationSweepResult[Key] };

/**
 * How many rows one tick looks up.
 *
 * A bound rather than "all of them", because a tick's duration is (rows × Horizon latency): a
 * backlog of a thousand in-flight payments would otherwise hold the single worker for minutes,
 * delaying the submissions queued behind it. Taking the *oldest deadlines first* means the rows
 * that are closest to being decidable are the ones that get looked at, and the rest arrive on the
 * following tick.
 */
export const CONFIRMATION_SWEEP_BATCH = 50;

/**
 * How long a `PROCESSING` row with no hash may sit before it is reported.
 *
 * Longer than every retry the submission job has (`attempts: 3`, 2s/4s backoff) plus the stalled-
 * job requeue, so a payment that is merely being retried right now is not reported as stuck. The
 * row is *reported* and not touched: re-driving a submission is the submission job's business,
 * and §5 of the proposal says why this step does not do it from here.
 */
export const STUCK_WITHOUT_HASH_AFTER_MS = 5 * 60_000;

/**
 * Confirmation polling (Step 28): the question Step 27 deliberately left open.
 *
 * A submission's answer from Horizon is *acceptance*, not settlement. This service is what turns
 * "Horizon took it" into "it is in a ledger" - `SUCCESSFUL` - or into a definitive no, `FAILED`
 * with a reason - and it is the only code that resolves a `PROCESSING` row.
 *
 * ## A sweep, not a per-payment timer
 *
 * One pass over the in-flight set, driven by a repeatable job (`confirm-payments`; see
 * `PaymentsQueueService`). The alternative - a delayed job per payment, scheduled at submission -
 * was rejected because it puts the work list in Redis: flush Redis, redeploy mid-flight, or lose
 * a job to a retention policy, and a payment sits `PROCESSING` with nothing that will ever look
 * at it again. Here the work list is the `transactions` table, which is the same durable record
 * the submission itself trusts, so a tick that never ran is repaired by the next one. The cost is
 * that a row is polled once per interval rather than on a schedule of its own, which is why the
 * interval is configurable and why the sweep takes a bounded batch.
 *
 * ## What one tick does, and the order it does it in
 *
 * 1. Read the in-flight rows *that have a hash* (oldest deadline first, `CONFIRMATION_SWEEP_BATCH`
 *    of them) and count the older ones that have none.
 * 2. Ask Horizon about each hash, one at a time: the network call is the only thing here that can
 *    be slow, and there is no reason to open fifty of them to a rate-limited public API.
 * 3. Decide with `triageConfirmation` - a pure function, so every row of its table is a test.
 * 4. Write through the state machine's writers (`markSuccessful`, `markFailed`), and act on the
 *    answer: a lost compare-and-set means another caller resolved the payment first, so this tick
 *    logs it and does nothing else.
 * 5. Record the resolution in the audit trail, then notify the sender - both *after* the write and
 *    only when the write was this tick's. An entry and a message are consequences of a resolution,
 *    never conditions of one, and running each in the tick that won the compare-and-set is what
 *    makes both at-most-once without any bookkeeping of their own.
 *
 * ## What a tick never does
 *
 * - It never writes a row it could not decide (`waiting`, `unresolved`): the row stays
 *   `PROCESSING`, and the next tick asks again. That is the whole difference between a payment
 *   that is slow and a payment that is reported wrongly.
 * - It never re-enqueues a submission. A `PROCESSING` row with no hash is *reported* (see
 *   `stuckWithoutHash`) rather than driven, because re-driving is a submission decision with its
 *   own bound, and a poller that could submit would be a second path to a signature.
 * - It never throws for one row's failure. A row that cannot be looked up is counted and logged;
 *   the tick's other rows are unaffected. A failure of the *query* is different - that throws, so
 *   the job fails loudly and BullMQ's own retry prices it.
 */
@Injectable()
export class PaymentsConfirmationService {
  private readonly logger = new Logger(PaymentsConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * The read half of Stellar, injected as the service rather than as the Horizon port: this
     * class asks "did it settle", and `StellarService` is the app's one door to that answer.
     */
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    /**
     * Step 32's record of what was asked, as opposed to what money did.
     *
     * The two entries here (`payment.completed`, `payment.failed`) are the ones that close the loop
     * `payment.initiated` opens, and they are written from *this* class rather than from
     * `markSuccessful`/`markFailed` because the writers are a state machine over one column and this
     * is the only class that knows a payment id, its sender, a ledger number or a failure reason at
     * the same time.
     */
    private readonly audit: AuditService,
  ) {}

  /**
   * One pass over the in-flight set. Safe to run concurrently with itself - every write is a
   * compare-and-set - and safe to run twice in a row, which is what makes it a repeatable job
   * rather than a stateful one.
   *
   * `now` is a parameter with a default so a test can place the clock where it needs it (a row
   * whose deadline is in the future versus one that passed it) without waiting for, or mocking,
   * time inside this method.
   */
  async sweep(now: Date = new Date()): Promise<ConfirmationSweepResult> {
    const rows = await this.prisma.transaction.findMany({
      where: { status: TransactionStatus.PROCESSING, stellarTxHash: { not: null } },
      select: {
        id: true,
        // Who created the payment, which the audit entry for its resolution names as the actor: the
        // sender is who the outcome happened to, and the id is the one identity here the sender's
        // phone number (below) is not allowed to stand in for.
        senderId: true,
        amount: true,
        stellarTxHash: true,
        submissionDeadline: true,
        // The sender's number is how a settlement reaches them (and is masked in every log line);
        // the recipient's handle is what the message names. Step 34c adds the address: a receipt
        // goes to it as well, but only once verified - see `verifiedEmail`.
        sender: { select: { phoneNumber: true, email: true, emailVerifiedAt: true } },
        recipient: { select: { handle: true } },
      },
      orderBy: { submissionDeadline: 'asc' },
      take: CONFIRMATION_SWEEP_BATCH,
    });

    const result: SweepTally = {
      polled: 0,
      confirmed: 0,
      failed: 0,
      waiting: 0,
      unresolved: 0,
      stuckWithoutHash: 0,
    };

    for (const row of rows) {
      // The query asked for rows with a hash, so this is unreachable - but it is what narrows the
      // column's type, and skipping is the only safe reading if a row this service is handed has
      // lost its hash.
      if (row.stellarTxHash === null) {
        continue;
      }

      result.polled += 1;

      let decision: ConfirmationDecision;

      try {
        decision = triageConfirmation({
          lookup: await this.stellar.lookupTransaction(row.stellarTxHash),
          deadline: row.submissionDeadline,
          now,
        });
      } catch (error) {
        /**
         * A rejection here is not an answer about the payment: the port resolves for every answer
         * Horizon gives, and a lookup only rejects for a bug on *this* side (a malformed hash
         * reaching the SDK, say). So the row is counted as undecidable and the tick moves on - one
         * unreadable row must not cost the other forty-nine their poll. A failed *query* is a
         * different thing entirely and still throws, so BullMQ prices that.
         */
        result.unresolved += 1;
        this.logger.error(
          `Payment ${row.id} could not be polled: ${
            error instanceof Error ? error.message : 'unknown failure'
          }`,
          error instanceof Error ? error.stack : undefined,
        );

        continue;
      }

      if (decision.kind === 'confirmed') {
        await this.confirm(row, decision.ledger, result);
      } else if (decision.kind === 'failed') {
        await this.fail(row, decision.reason, result);
      } else if (decision.kind === 'waiting') {
        result.waiting += 1;
        this.logger.debug(`Payment ${row.id} is still in flight: ${decision.detail}`);
      } else {
        result.unresolved += 1;
        // `warn` rather than `debug`: both reasons here mean nothing will resolve this row until
        // something changes (Horizon answering, or a deadline being recorded), and a payment
        // nobody can decide is worth a line in the log even when it is not yet a problem.
        this.logger.warn(`Payment ${row.id} cannot be resolved yet: ${decision.detail}`);
      }
    }

    const stuck = await this.stuckWithoutHash(now);

    if (stuck > 0) {
      this.logger.warn(
        `${stuck} payment(s) have been PROCESSING for over ${Math.round(
          STUCK_WITHOUT_HASH_AFTER_MS / 60_000,
        )} minutes with no transaction recorded - nothing to poll; they need a re-drive or an operator`,
      );
    }

    return { ...result, stuckWithoutHash: stuck };
  }

  /**
   * Resolves a payment as successful, records it, notifies, and counts it - in that order - and the
   * order is the design.
   *
   * The compare-and-set decides who gets to do the rest: `false` means another caller (a second
   * API instance, an overlapping tick) resolved this payment between this tick's read and this
   * write, so this tick says nothing about it. That is what makes the audit entry and the
   * notification at-most-once per resolution without any bookkeeping of their own - the winner of
   * the write is the only caller that produces either.
   */
  private async confirm(
    row: SweepRow,
    ledger: number,
    result: SweepTally,
  ): Promise<void> {
    const written = await markSuccessful(this.prisma, row.id);

    if (!written) {
      this.logger.log(`Payment ${row.id} was resolved by another caller while this tick ran`);
      return;
    }

    result.confirmed += 1;

    this.logger.log(
      `Payment ${row.id} confirmed in ledger ${ledger} (${row.stellarTxHash ?? 'no hash'})`,
    );

    /**
     * Step 32: `payment.completed`, written after the compare-and-set and before the notification,
     * and both halves of that are decisions.
     *
     * After the write, because the entry records an outcome and there is no outcome until the row
     * says so - the `false` above returns before this line, which is the tick that lost the race and
     * therefore records nothing. Before the notification, because the two failures are not equally
     * bad: a provider outage that loses the SMS leaves the money fact recorded here, where an entry
     * written after a `notify` that threw would leave a settled payment with nothing in the trail.
     *
     * The ledger number is the one piece of context worth the row - it is what an operator takes to
     * an explorer, and it is a number this app read from Horizon rather than anything a client sent.
     * The hash is deliberately not repeated: the `transactions` row holds it, and a copy in a table
     * that cannot be corrected is a copy that can be wrong.
     */
    await this.audit.log({
      action: 'payment.completed',
      userId: row.senderId,
      subjectId: row.id,
      outcome: 'ok',
      metadata: { ledger },
    });

    await this.notify(row, 'SUCCESSFUL');
  }

  /**
   * The same, for a definitive no. The reason is the writer's column value and this line's text.
   *
   * `payment.failed` carries that reason for the same purpose the entry above carries its ledger: it
   * is a code this app produced (`not-found-after-deadline`, `landed-unsuccessful:tx_failed` - see
   * `triageConfirmation`, which is a pure function precisely so every one of them is a test), not a
   * provider's words, which is what makes it safe in a table support reads.
   */
  private async fail(
    row: SweepRow,
    reason: string,
    result: SweepTally,
  ): Promise<void> {
    const written = await markFailed(this.prisma, row.id, reason);

    if (!written) {
      this.logger.log(`Payment ${row.id} was resolved by another caller while this tick ran`);
      return;
    }

    result.failed += 1;

    this.logger.warn(`Payment ${row.id} failed: ${reason}`);

    await this.audit.log({
      action: 'payment.failed',
      userId: row.senderId,
      subjectId: row.id,
      outcome: 'failed',
      metadata: { reason },
    });

    await this.notify(row, 'FAILED');
  }

  /**
   * Tells the sender what happened, and never lets that failure become the payment's.
   *
   * The row is already written by the time this runs, which is the ordering that matters: a
   * provider outage must not turn a settled payment back into an unsettled one, and it must not
   * make the job fail (which would retry a resolution that is already done). So the error is
   * logged with the payment id and swallowed - the money fact is the row, and the SMS is a
   * courtesy that Step 41's alerting can chase.
   */
  private async notify(row: SweepRow, status: 'SUCCESSFUL' | 'FAILED'): Promise<void> {
    try {
      await this.notifications.sendPaymentResult(
        row.sender.phoneNumber,
        {
          status,
          // The stored amount, read back through the money module rather than echoed: the message
          // then cannot disagree with the column.
          amount: Amount.fromDatabase(row.amount).toString(),
          recipientHandle: row.recipient.handle,
        },
        // Step 34c: the address, but only once a code has proved it. An address merely attached
        // (`email` set, `email_verified_at` null) is passed as `null`, so a receipt cannot be sent
        // to a mailbox nobody has shown they can read - and `sendPaymentResult`'s email arm treats
        // `null` as "no second channel".
        this.verifiedEmail(row.sender),
      );
    } catch (error) {
      this.logger.error(
        `Payment ${row.id} is ${status}, but the notification could not be sent - ${
          error instanceof Error ? error.message : 'unknown failure'
        }`,
      );
    }
  }

  /**
   * The address a receipt may go to, or `null` (Step 34c).
   *
   * `email` is the address the account *claims* and `emailVerifiedAt` is when a code proved the
   * account controls it; only the second makes the address a delivery channel, so the two columns
   * are read together here and an attached-but-unproved address is reported as `null` rather than
   * as itself. That is the one rule this method exists to state: a receipt is email, and email
   * goes only where someone has proved they can read it.
   */
  private verifiedEmail(sender: SweepRow['sender']): string | null {
    return sender.emailVerifiedAt === null ? null : sender.email;
  }

  /**
   * `PROCESSING` rows with no hash, older than the reporting window.
   *
   * `updatedAt` rather than `createdAt`: a row being retried right now is a row whose claim has
   * just been written, and what makes this count interesting is *staleness* - nothing has touched
   * the row since. Counted, never written: see the class docstring.
   */
  private stuckWithoutHash(now: Date): Promise<number> {
    return this.prisma.transaction.count({
      where: {
        status: TransactionStatus.PROCESSING,
        stellarTxHash: null,
        updatedAt: { lt: new Date(now.getTime() - STUCK_WITHOUT_HASH_AFTER_MS) },
      },
    });
  }
}

/** The columns one in-flight row is polled with - the query's `select`, as a type. */
interface SweepRow {
  readonly id: string;
  /** `transactions.sender_id`: the actor the resolution's audit entry is attributed to. */
  readonly senderId: string;
  readonly amount: { toString(): string };
  readonly stellarTxHash: string | null;
  readonly submissionDeadline: Date | null;
  readonly sender: {
    readonly phoneNumber: string;
    /** The claimed address, or `null`. Only sent to when `emailVerifiedAt` is set - see `verifiedEmail`. */
    readonly email: string | null;
    readonly emailVerifiedAt: Date | null;
  };
  readonly recipient: { readonly handle: string | null };
}
