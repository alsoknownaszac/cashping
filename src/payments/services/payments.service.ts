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
import { PaymentCreatedResponseDto } from '../dto/payment-created-response.dto.js';
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
 * Payment creation (Step 25): `POST /v1/payments`, up to the moment the row exists.
 *
 * ## What this step is responsible for, and what it is not
 *
 * A payment is created as a `PENDING` `transactions` row, and nothing else happens: no key is
 * opened, nothing is signed, and Horizon is not told anything. Those are Day 4's (Steps 27-29),
 * and keeping them out is what makes this step's two claims testable on their own - exactly one
 * row per idempotency key, and no overdraft under concurrency.
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
  ) {}

  /**
   * `POST /v1/payments`: validate, reserve, write, answer with the id.
   *
   * The order of the four checks is the order of what they cost and what they mean:
   *
   * 1. **The amount**, parsed server-side. Cheap, purely local, and nothing else can be judged
   *    before it is known.
   * 2. **The recipient** - a database read - so a payment to nobody payable never takes a lock,
   *    never reads Horizon and never writes a row.
   * 3. **The sender's balance**, a Horizon read (through `BalancesService`, the one definition of
   *    what a wallet holds), which also refuses a wallet that cannot hold USDC at all.
   * 4. **The lock, the in-flight sum and the insert**, together, because that is the part that
   *    has to be atomic.
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
         * string into a `Decimal` for the `numeric(20, 7)` column without a float anywhere, and
         * `PENDING` is stated rather than left to the column's default so that the status a
         * payment is created in is visible in the code that creates it.
         */
        return tx.transaction.create({
          data: {
            senderId: sender.id,
            recipientId: recipient.id,
            amount: amount.toString(),
            status: TransactionStatus.PENDING,
            idempotencyKey,
          },
          select: { id: true, status: true, amount: true, createdAt: true },
        });
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
