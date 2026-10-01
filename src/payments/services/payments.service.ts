import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Amount, InvalidAmountError } from '../../common/money/amount.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BalancesService } from '../../wallet/balances/balances.service.js';
import { type CreatePaymentDto } from '../dto/create-payment.dto.js';
import { type ListPaymentsQueryDto } from '../dto/list-payments.dto.js';
import { PaymentCreatedResponseDto } from '../dto/payment-created-response.dto.js';
import { PaymentListItemDto, PaymentListResponseDto } from '../dto/payment-list-response.dto.js';
import { PaymentResponseDto } from '../dto/payment-response.dto.js';
import {
  InvalidHistoryQueryError,
  PAYMENT_HISTORY_ORDER,
  buildPaymentHistoryWhere,
  directionFor,
  invalidHistoryQueryMessage,
  membershipWhere,
  parsePaymentHistoryQuery,
  takePage,
  type PaymentHistoryQuery,
} from '../history/payment-history-query.js';
import { PaymentsQueueService } from '../jobs/payments-queue.service.js';
import { RecipientsService } from './recipients.service.js';

/**
 * The statuses whose amounts are already spoken for.
 *
 * `PENDING` is a payment created and not yet submitted (this step); `PROCESSING` is one the
 * network has been asked about and has not answered (Step 27). Both are money the sender has
 * committed and Horizon has not debited yet, so both have to come off the wallet's balance
 * before another payment is allowed - otherwise a burst of payments each sees the same
 * pre-debit balance and every one of them passes.
 *
 * `SUCCESSFUL` is deliberately not here: once the network has closed the transaction in a
 * ledger, Horizon's own balance already reflects it, and counting it again would double-charge
 * the sender. `FAILED` is not here because nothing was spent.
 */
const IN_FLIGHT = [TransactionStatus.PENDING, TransactionStatus.PROCESSING] as const;

/** A sender with nothing in flight has this much committed. */
const NOTHING_IN_FLIGHT = Amount.fromString('0');

/**
 * The row a successful create returns, as much of it as the response needs.
 *
 * `amount` is typed structurally (`toString`) rather than as Prisma's `Decimal`, the same way
 * `Amount.fromDatabase` is: this file reads the column back, and how the driver spells a
 * `numeric` is `common/money`'s business, not this module's.
 */
interface CreatedTransaction {
  readonly id: string;
  readonly status: TransactionStatus;
  readonly amount: { toString(): string };
  readonly createdAt: Date;
}

/**
 * What a history page reads.
 *
 * Named here for the same reason `RecipientsService` names its `SEARCH_COLUMNS`: what a list
 * discloses is a list in one place rather than a habit spread over two queries, and the *absence*
 * of `failureReason` and `stellarTxHash` is then something a reviewer can see rather than assume.
 *
 * `senderId` is read and never rendered. It is what `directionFor` needs to answer "sent or
 * received" for the caller, and on a row the caller sent it is the caller's own id - so it is not
 * a disclosure, it is the field the answer is derived from.
 */
const HISTORY_COLUMNS = {
  id: true,
  senderId: true,
  recipientId: true,
  status: true,
  amount: true,
  createdAt: true,
} as const;

/** What the detail read adds: the two fields worth reading one payment for. See `PaymentResponseDto`. */
const DETAIL_COLUMNS = {
  ...HISTORY_COLUMNS,
  failureReason: true,
  stellarTxHash: true,
} as const;

/**
 * One history row, as much of it as a response needs.
 *
 * `amount` is typed structurally (`toString`) rather than as Prisma's `Decimal`, the same way
 * `CreatedTransaction` types it: this file reads the column back, and how the driver spells a
 * `numeric` is `common/money`'s business, not this module's.
 */
interface HistoryTransaction {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly status: TransactionStatus;
  readonly amount: { toString(): string };
  readonly createdAt: Date;
}

/** A history row plus the two fields only `GET /v1/payments/:id` reads. */
interface DetailedTransaction extends HistoryTransaction {
  readonly failureReason: string | null;
  readonly stellarTxHash: string | null;
}

/**
 * Payments over HTTP: creation (Step 25) and history (Step 30).
 *
 * `POST /v1/payments` runs up to the moment the row exists - written, reserved against the sender,
 * queued for submission. The two reads answer about rows that already do: one payment to the
 * caller who is a party to it, and a filtered page of the caller's own history. They share this
 * file because they share the row and its vocabulary, and they share nothing else - a read touches
 * no wallet, no queue and no network, and both of them delegate what a caller may *see* to
 * `history/payment-history-query.ts` rather than deciding it here.
 *
 * ## What this step is responsible for, and what it is not
 *
 * A payment is created as a `PENDING` `transactions` row, and a submission job for it is put on
 * the queue in the same transaction (Step 27) - that enqueue is the one line of Day 4 that belongs
 * here, because it is the last thing that can be made atomic with the row's creation. Nothing else
 * happens: no key is opened, nothing is signed, and Horizon is not told anything. Those are
 * `PaymentsSubmissionService`'s, and keeping them out is what makes this step's two claims testable
 * on their own - exactly one row per idempotency key, and no overdraft under concurrency.
 *
 * The money question this step *does* answer is "may the sender spend this much right now", and
 * the answer is computed rather than remembered:
 *
 *     spendable = Horizon's USDC balance for the sender  -  the sender's in-flight payments
 *
 * That way round deliberately. Horizon is the truth about what the wallet holds, and it is *not*
 * cached, defaulted or mirrored into a column (Step 20's audit is the reason, and its docstring
 * records it): a cached balance would be a second source of truth, and this codebase's answer to
 * "the two disagree" is Step 31's reconciliation job rather than a race between them. The
 * subtraction exists because a `PENDING` payment has not reached the network yet, so Horizon
 * cannot know about it - without it, two concurrent payments would each see the whole balance.
 *
 * ## The lock, and why it is raw SQL
 *
 * `SELECT ... FOR UPDATE` on the sender's `stellar_accounts` row is the one deliberate raw-SQL
 * escape hatch in the codebase (the build sequence names it as such): Prisma has no row-lock
 * primitive, and no `$transaction` provides one, because the isolation level Prisma can ask for
 * does not stop two transactions from both reading the same balance and both inserting a row. A
 * lock does: the second transaction waits on the row, and when it is let in, its `SUM` of
 * in-flight amounts sees the first transaction's committed insert.
 *
 * What the lock *is* is a serialisation point for one sender; what it is not is a lock on money.
 * The row it holds is the wallet, which is the thing whose spending decision has to be
 * indivisible. Two senders never wait for each other (different rows), and one sender's two
 * payments are evaluated one after the other, in the order they arrived.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * - **The Horizon read happens before the lock, not inside it.** A network round trip is not
 *   something to hold a row lock across: a Horizon that is slow for a second would block every
 *   payment for that sender for that second, and one that hangs would hold the lock until it
 *   timed out. The read is a snapshot of the network taken at the start of the request, which is
 *   what it would be inside the lock too - Horizon was never part of this transaction.
 * - **The in-flight sum happens inside it, after the lock.** That is where it has to be: it is
 *   the read the lock exists to serialise, and it is a local index scan (`@@index([senderId,
 *   status])`) rather than a network call.
 *
 * ## What the response says, and what it cannot say
 *
 * `202 Accepted` with the transaction id: accepted for *submission*, not paid. The row is
 * `PENDING` and the client is told exactly that. Nothing here can promise the network will
 * accept the payment later - Day 4's job is to turn this row into a verdict, and Step 29 is
 * where the statuses describing that verdict come from.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly recipients: RecipientsService,
    /**
     * Where the submission job goes (Step 27). Injected as the service rather than as BullMQ's
     * `Queue`, so that this file adds a *payment* to the queue and never learns a job name, a
     * payload shape or a retry policy - see `PaymentsQueueService`.
     */
    private readonly queue: PaymentsQueueService,
  ) {}

  /**
   * `POST /v1/payments`: validate, reserve, write, answer with the id.
   *
   * The order of the checks is the order of what they cost and what they mean:
   *
   * 1. **The amount**, parsed server-side. Cheap, purely local, and nothing else can be judged
   *    before it is known.
   * 2. **The recipient** - a database read - so a payment to nobody payable never takes a lock,
   *    never reads Horizon and never writes a row.
   * 3. **The sender's balance**, a Horizon read (through `BalancesService`, the one definition of
   *    what a wallet holds), which also refuses a wallet that cannot hold USDC at all.
   * 4. **The lock, the in-flight sum, the insert and the enqueue**, together, because that is the
   *    part that has to be atomic - and the enqueue is inside it because a committed row with no
   *    job is the one failure here that nothing would ever report (see the comment on the call).
   *
   * `idempotencyKey` reaches the column rather than living only in Redis, so "one key, one
   * payment" survives a claim that was never written (see `IdempotencyInterceptor`). It is
   * validated by the interceptor on the way in - this method treats it as opaque, because what a
   * key looks like is a wire concern.
   */
  async create(
    sender: SessionUser,
    dto: CreatePaymentDto,
    idempotencyKey: string,
  ): Promise<PaymentCreatedResponseDto> {
    const amount = parseAmount(dto.amount);
    assertNotSelf(sender.id, dto.recipientId);

    const recipient = await this.recipients.assertPayableRecipient(dto.recipientId);
    const available = await this.availableUsdc(sender.id);

    let created: CreatedTransaction;

    try {
      created = await this.prisma.$transaction(async (tx) => {
        await lockSenderWallet(tx, sender.id);

        const inFlight = await this.inFlightFor(tx, sender.id);

        assertCovers(available, inFlight, amount);

        /**
         * One row, with the amount written as the string `Amount` produced. Prisma parses that
         * string into a `Decimal` for the `numeric(20, 7)` column without a float anywhere.
         *
         * The status is deliberately *not* written here any more (Step 29). A payment is created
         * `PENDING`, which the column's own `@default(PENDING)` declares, and the rule this step
         * added is that the state machine is the only code that writes a status: this file no longer
         * names the column at all, which leaves one statement of what a payment starts as
         * (`schema.prisma`) and one writer of what it becomes (`transaction-status.ts`).
         * `npm run lint:status` is what keeps it that way.
         */
        const row = await tx.transaction.create({
          data: {
            senderId: sender.id,
            recipientId: recipient.id,
            amount: amount.toString(),
            idempotencyKey,
          },
          select: { id: true, status: true, amount: true, createdAt: true },
        });

        /**
         * The submission job, added *inside* this transaction and last, before the commit
         * (Step 27). The ordering is the whole decision, and both of its failure modes are
         * survivable - but only one of them is silent:
         *
         * - Commit first, enqueue after: a crash in between leaves a `PENDING` row with no job on
         *   the queue. Nothing retries it, nothing reports it, and it looks exactly like a payment
         *   that is about to be submitted. That is the failure this ordering refuses.
         * - Enqueue first, commit after (this): a rollback - or a crash before the commit - leaves
         *   a job for a payment that does not exist. The handler throws on that ("this job has no
         *   row"), it is retried and then logged as failed by the processor, and no money moves.
         *
         * The enqueue is awaited rather than fired and forgotten, because a caller that answered
         * `202` before the job was on the queue would be promising a submission nobody had agreed
         * to attempt - and because the Redis command behind it is bounded (see
         * `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS`), so it cannot hold this row lock for long.
         */
        await this.queue.enqueueSubmission(row.id);

        return row;
      });
    } catch (error) {
      throw asKeyReuse(error, idempotencyKey);
    }

    return {
      id: created.id,
      status: created.status,
      // Re-read from the row rather than echoing the request: see the DTO's docblock.
      amount: Amount.fromDatabase(created.amount).toString(),
      recipientId: recipient.id,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /**
   * `GET /v1/payments/:id` (Step 30): one payment, if the caller is a party to it.
   *
   * A single `findFirst` whose predicate *is* the access control, rather than a `findUnique`
   * followed by a comparison. That is the decision, not a style: the caller's id is part of the
   * query, so "this id belongs to two other people" and "no row has this id" are one row-less
   * answer and one 404 - which keeps this endpoint from becoming an oracle for which payment ids
   * exist (the same rule `RecipientsController`'s 404 records for account ids). Split into
   * "fetch, then check" it would be the same answer written twice, with a window in between for
   * the second half to be forgotten.
   *
   * Nothing else happens here. No wallet is read, no allowance is spent, Horizon is not asked: this
   * answers about a row this API itself wrote, so it cannot cost money or reach the network.
   */
  async findOne(userId: string, id: string): Promise<PaymentResponseDto> {
    const row: DetailedTransaction | null = await this.prisma.transaction.findFirst({
      where: { id, ...membershipWhere(userId, 'both') },
      select: DETAIL_COLUMNS,
    });

    if (row === null) {
      throw new NotFoundException(
        'No payment with that id involves this account. Check the id, or list your payments.',
      );
    }

    return {
      id: row.id,
      status: row.status,
      // Re-read from the row, as `create` does: the response then cannot disagree with the column.
      amount: Amount.fromDatabase(row.amount).toString(),
      direction: directionFor(row, userId),
      recipientId: row.recipientId,
      createdAt: row.createdAt.toISOString(),
      // `null` stays `null` rather than being dropped, so a client can switch on presence.
      failureReason: row.failureReason,
      stellarTxHash: row.stellarTxHash,
    };
  }

  /**
   * `GET /v1/payments` (Step 30): one filtered page of the caller's history, newest first.
   *
   * The query is parsed before the database is touched, so a bad `direction`, an unreadable date or
   * an inverted range costs nothing and names the parameter it was about. What is left is one
   * indexed read of `limit + 1` rows and a `slice`, which is where `hasMore` comes from: the page
   * and its "is there more" question are the same read, so they cannot disagree - where a second
   * `count()` is a different query at a different moment.
   *
   * The scope is membership (`buildPaymentHistoryWhere`), so a filter can only narrow what the
   * caller may see and can never widen it - there is no parameter that names whose payments to
   * read, because the answer is always "the caller's".
   */
  async history(userId: string, dto: ListPaymentsQueryDto): Promise<PaymentListResponseDto> {
    const query = readHistoryQuery(dto);

    const rows: HistoryTransaction[] = await this.prisma.transaction.findMany({
      where: buildPaymentHistoryWhere(userId, query),
      orderBy: PAYMENT_HISTORY_ORDER,
      take: query.limit + 1,
      select: HISTORY_COLUMNS,
    });

    const page = takePage(rows, query.limit);

    return {
      items: page.items.map((row) => toListItem(row, userId)),
      hasMore: page.hasMore,
    };
  }

  /**
   * What the sender can spend right now: Horizon's USDC line for their wallet.
   *
   * Three failures are answered here rather than deeper, because all three are this service's
   * to report:
   *
   * - **No wallet** - `BalancesService` throws `NotFoundException` for that, and its sentence
   *   ("No Stellar account has been provisioned for this user yet") is exactly right for a
   *   payment, so it is not re-worded.
   * - **Horizon did not answer** - likewise a `503`, and the reason the payment is refused
   *   instead of being allowed against an unknown balance. Guessing here means guessing about
   *   money; a client can retry.
   * - **A wallet that cannot hold USDC** (no trustline, or one the issuer has not authorised) -
   *   a 400: the request is not malformed, but this account cannot make a USDC payment until its
   *   trustline exists, and Step 19 is what creates it. `balance` is `null` in exactly the
   *   `missing` case, which is why both are checked together.
   */
  private async availableUsdc(senderId: string): Promise<Amount> {
    const wallet = await this.balances.balanceFor(senderId);

    if (wallet.balance === null || wallet.trustline !== 'active') {
      throw new BadRequestException(
        'This wallet cannot hold USDC yet, so it cannot make a payment. Try again once the wallet has finished being set up.',
      );
    }

    return Amount.fromDatabase(wallet.balance);
  }

  /**
   * How much this sender has already committed, summed by Postgres.
   *
   * A `SUM` over the sender's in-flight rows rather than a list read into memory: the arithmetic
   * is exact in `numeric`, where the values live, and nothing but the total is needed. `null`
   * means no rows matched - `SUM` of nothing is not zero - so the distinction is handled here
   * instead of assumed.
   */
  private async inFlightFor(tx: Prisma.TransactionClient, senderId: string): Promise<Amount> {
    const inFlight = await tx.transaction.aggregate({
      where: { senderId, status: { in: [...IN_FLIGHT] } },
      _sum: { amount: true },
    });

    return inFlight._sum.amount === null
      ? NOTHING_IN_FLIGHT
      : Amount.fromDatabase(inFlight._sum.amount);
  }
}

/**
 * The sender's wallet row, locked for the rest of the transaction.
 *
 * The lock target is `stellar_accounts` - the row that *is* the sender's account, one per user
 * (`user_id` is unique) - because what must not happen twice at once is that account's spending
 * decision. Locking it rather than the `users` row also means the statement proves the wallet
 * exists, so a sender with no account row is a 404 from the same query that would have locked
 * it.
 *
 * `FOR UPDATE` is the whole of the escape hatch: Prisma exposes no row lock, and this is the one
 * place the codebase drops to SQL. It is a tagged template, so the id is a bind parameter rather
 * than concatenated text, and the `uuid` cast is what lets the column's own type drive the index
 * lookup instead of comparing as text.
 */
async function lockSenderWallet(tx: Prisma.TransactionClient, senderId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "stellar_accounts" WHERE "user_id" = ${senderId}::uuid FOR UPDATE
  `;

  if (locked.length === 0) {
    throw new NotFoundException('No Stellar account has been provisioned for this user yet.');
  }
}

/**
 * Refuses a payment the sender's available money cannot cover.
 *
 * `available - inFlight >= amount`, using the two operations the money module was extended with
 * for exactly this (see `Amount.minus` and `Amount.isAtLeast`): `>=` because spending the
 * balance down to zero is a legal payment, and the subtraction because in-flight amounts are
 * money already committed.
 *
 * A 409 rather than a 400: the request is well formed and the amount is a real amount - what
 * does not fit is the current state of the account, which may be different a minute from now
 * once money arrives. The message carries the spendable figure because it is the sender's own
 * balance and the number a client needs to render ("you can send up to X").
 */
function assertCovers(available: Amount, inFlight: Amount, amount: Amount): void {
  const spendable = available.minus(inFlight);

  if (spendable.isAtLeast(amount)) {
    return;
  }

  throw new ConflictException(
    `Not enough USDC in this wallet for that payment. Available to spend: ${spendable.toString()}.`,
  );
}

/**
 * The amount, or nothing to do.
 *
 * Two rules, both from the money module rather than from this file: the text has to be an amount
 * (`Amount.fromString`, whose message names the reason and becomes the 400's body) and it has to
 * be more than zero. Zero is refused here rather than in the DTO because it is a money rule -
 * `Amount.isPositive`'s docblock records the bug that made it a method - and the rejection is
 * phrased as an `InvalidAmountError` so there is one message shape for "not an amount you can
 * send".
 */
function parseAmount(text: string): Amount {
  const amount = tryAmount(text);

  if (!amount.isPositive()) {
    throw new BadRequestException(
      new InvalidAmountError(text, 'zero, and a payment of nothing is not a payment').message,
    );
  }

  return amount;
}

/** `Amount.fromString`, with its refusal turned into the 400 it is at the edge. */
function tryAmount(text: string): Amount {
  try {
    return Amount.fromString(text);
  } catch (error) {
    if (error instanceof InvalidAmountError) {
      throw new BadRequestException(error.message);
    }

    throw error;
  }
}

/**
 * Refuses a transfer to your own account.
 *
 * A product rule this step adds, so it is stated rather than left implicit: paying yourself moves
 * no money, burns a Stellar fee and a sequence number when Day 4 submits it, and would appear as
 * a payment in both directions in the history Step 30 builds. Confirming your own id
 * (`GET /v1/recipients/:id`) is still allowed - that read is how the frontend's confirmation
 * component answers "this one is you" - because a read of yourself is not a payment.
 */
function assertNotSelf(senderId: string, recipientId: string): void {
  if (senderId === recipientId) {
    throw new BadRequestException(
      'A payment has to go to someone else. Sending to your own account would move nothing.',
    );
  }
}

/**
 * Translates the one database error this insert can raise on purpose.
 *
 * `P2002` on `transactions` is the unique index over (sender, idempotency key) - the table's only
 * unique constraint - and it is *good* news when it fires: the payment this key describes already
 * exists, and a retry must not create a second one. Reaching here means the Redis claim was gone
 * (expired, flushed, another instance, a bug), which is exactly the case the index exists for; a
 * 409 tells the client to look at the payment it already made, where a 500 would tell it nothing.
 * Every other error keeps travelling to the global filter, where a real database failure belongs.
 */
function asKeyReuse(error: unknown, idempotencyKey: string): Error {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(
      `This Idempotency-Key already created a payment (key ${idempotencyKey}). Fetch that payment instead of sending it again.`,
    );
  }

  return error as Error;
}

/**
 * The history query as the module reads it, with its refusal turned into the 400 it is at the edge.
 *
 * The same two lines `RecipientsService.classify` writes for `UnsearchableQueryError`, for the same
 * reason: the module states the fact about the input, and only the service knows that over HTTP the
 * fact is a 400 carrying a sentence naming the parameter. Nothing else can come out of the parse,
 * which is why there is no second `instanceof` here.
 */
function readHistoryQuery(dto: ListPaymentsQueryDto): PaymentHistoryQuery {
  try {
    return parsePaymentHistoryQuery(dto);
  } catch (error) {
    if (error instanceof InvalidHistoryQueryError) {
      throw new BadRequestException(invalidHistoryQueryMessage(error.problem));
    }

    throw error;
  }
}

/**
 * A row, as one page of history spells it.
 *
 * The amount goes through `Amount.fromDatabase(...).toString()` rather than `row.amount.toString()`
 * directly, which is the same round trip `create`'s response makes: `numeric(20, 7)` comes back as
 * the driver's `Decimal`, and how that becomes text on the wire is `common/money`'s decision - the
 * one place a 7-decimal amount is guaranteed not to have been through a JS `number`.
 */
function toListItem(row: HistoryTransaction, userId: string): PaymentListItemDto {
  return {
    id: row.id,
    status: row.status,
    amount: Amount.fromDatabase(row.amount).toString(),
    direction: directionFor(row, userId),
    recipientId: row.recipientId,
    createdAt: row.createdAt.toISOString(),
  };
}
