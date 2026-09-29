import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeedCustodyService } from '../custody/seed-custody.service.js';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
  type StellarBalanceLine,
} from '../stellar/account-source.js';
import { StellarService } from '../stellar/stellar.service.js';
import {
  StellarSubmissionUnavailableError,
  type SubmittedTransaction,
} from '../stellar/transaction-submitter.js';
import {
  ACCOUNT_FUNDER,
  AccountFundingUnavailableError,
  type AccountFunder,
  type FundingOutcome,
  type FundingResult,
} from './account-funder.js';
import { UsdcTrustlineService, type TrustlineAccountRow } from './usdc-trustline.js';

/**
 * How far a provisioning attempt got before it stopped.
 *
 * The three stages are the three things that can be true of a user who does not have
 * a usable account yet, and they are named for what an operator would have to do
 * about each:
 *
 * - `storage` - no account row was written, so *nothing exists* on the network
 *   either and a retry starts from nothing. (The only way to reach this with a row in
 *   the database is a concurrent attempt winning the unique index, which is reported
 *   as `already-provisioned` rather than as a failure.)
 * - `funding` - the row exists and the key is sealed, but the account does not exist
 *   on the ledger. Retrying is safe *and does not re-fund*: a call that finds the
 *   account already on the network skips the funder entirely, so "funded it twice" is
 *   not a state this flow can reach - on the funder that pays repeats, that difference
 *   is 10,000 XLM per attempt. The row is what makes the attempt retryable, because it
 *   is the only record of the key whose account still has to be created.
 * - `trustline` - the account exists with XLM but cannot receive USDC, which is the
 *   half-provisioned state Step 19 exists to avoid. Retrying is safe and idempotent
 *   (`changeTrust` on an existing trustline is a no-op), so this is a *deferred*
 *   problem, not a lost one - but it is not a state to leave a user in, because a
 *   payment sent to them right now fails at the sender.
 */
export type ProvisioningStage = 'storage' | 'funding' | 'trustline';

/**
 * What one provisioning attempt did.
 *
 * Three states rather than a boolean, because "success" and "failure" are not the
 * two answers a caller this close to a committed database write can act on:
 *
 * - `provisioned` - the account exists, is funded, and trusts USDC. Carries the
 *   transaction hashes so a log line (or an operator) can point at what happened.
 * - `already-provisioned` - the account is *finished*: it exists on the network, is
 *   funded, and trusts USDC. This call wrote nothing, submitted nothing and invoked no
 *   funder. It is the *normal* answer for a repeated attempt, not an error - and it is
 *   asserted against Horizon rather than inferred from the row, because a row says
 *   nothing about whether the flow that wrote it got any further than the insert.
 * - `incomplete` - an attempt was made and did not finish. `stage` says how far it
 *   got, and is `undefined` when the attempt was interrupted before the flow could
 *   tell (the deadline) or hit something it did not anticipate (a bug), because
 *   guessing a stage would be worse than admitting not knowing one.
 *
 * `incomplete` is deliberately not an exception. See `provisionFor`.
 */
export type ProvisioningOutcome =
  | {
      readonly status: 'provisioned';
      readonly accountId: string;
      readonly publicKey: string;
      readonly funding: FundingOutcome;
      /**
       * `undefined` when no funder ran for this attempt - a *resumed* account's XLM came
       * from an earlier attempt, so there is no funding transaction of this call's to name.
       */
      readonly fundingTransactionHash: string | undefined;
      /** Always a real submission: reaching `provisioned` means `ensureFor` ran in this call. */
      readonly trustlineTransactionHash: string;
    }
  | {
      readonly status: 'already-provisioned';
      readonly accountId: string;
      readonly publicKey: string;
    }
  | {
      readonly status: 'incomplete';
      readonly stage: ProvisioningStage | undefined;
      readonly accountId: string | undefined;
      readonly publicKey: string | undefined;
      readonly detail: string;
    };

/**
 * Provisions a wallet for a verified user (Step 19).
 *
 * The step's requirement is an outcome, not an endpoint: *after verification, the
 * user has a funded account that can hold USDC, without doing anything else*. This
 * service is the whole of that outcome - key material (Step 18's custody), a funded
 * account (`AccountFunder`), and a trustline (`UsdcTrustlineService`) - arranged in
 * an order that survives being interrupted at any point.
 *
 * ## The order, and why it is not the obvious one
 *
 * 1. **Read the user, refuse one who is not verified, and ask Horizon what a user who
 *    already has an account still needs.** `userId` is `@unique` on the account table,
 *    so the database enforces "at most one account per user"; the read turns the common
 *    repeat into a network check instead of an exception - and the verification guard
 *    turns "we somehow got here for an unverified user" into a refusal rather than a
 *    funded account for a number nobody has proven they own, *including* when a row
 *    already exists and is only half provisioned.
 * 2. **Seal the key and insert the row, before any value exists - and only when there is
 *    no row to resume.** Fund first and the window between the funding transaction and
 *    the insert is a window in which XLM is attached to a key whose only sealed copy is a
 *    local variable. A crash there does not leave an orphaned account to clean up - it
 *    leaves *money nobody holds the key to*, because the envelope is gone and the keypair
 *    was never persisted. Insert first and the worst case is an unfunded row: recoverable,
 *    visibly incomplete, and - because a row is resumed rather than reported as finished -
 *    recoverable *by calling this again*.
 * 3. **Fund**, which is where the account starts to exist on the network.
 * 4. **Trustline**, so the account can be paid in USDC. Funded-but-untrusted is the
 *    state the build sequence calls out as "not usable": a USDC payment to it fails
 *    for the sender, who cannot tell that the recipient was mid-setup.
 *
 * Every step is retryable from the state the previous one left behind, which is why a
 * failure reports a *stage* rather than rolling anything back. There is nothing to
 * roll back: a Testnet fee is not worth a compensating transaction, and the row is
 * the thing that makes the whole sequence resumable.
 *
 * ## This never throws
 *
 * `provisionFor` returns an outcome for every failure, including ones it cannot
 * classify. The caller is a request that has already committed the fact it is
 * answering about - the phone number is verified and the code is consumed - so an
 * exception here would turn a successful verification into an error response whose
 * retry cannot succeed (the code is spent). The user would be told they failed when
 * they had succeeded, and the account they now own would be invisible to them.
 *
 * The trade is that a programming error surfaces as a log line rather than as a 500.
 * That is the right way round here: it is the one place in Step 19 where neither
 * outcome is good, and "the request succeeds and an operator is paged by a
 * `Provisioning failed` line" fails better than "the user is stuck".
 *
 * ## The deadline
 *
 * The whole sequence runs under `STELLAR_PROVISIONING_TIMEOUT_MS`, a ceiling on the
 * *flow* rather than on a call. The funder bounds its own request and the SDK bounds a
 * submission, but an account load has no bound worth relying on, so one hung socket
 * could otherwise hold a user-facing request open indefinitely. When the deadline
 * fires the work is *not* cancelled - nothing can cancel a request already in flight -
 * it is simply no longer waited for, and its outcome is dropped. That is acceptable
 * because nothing outside this method's return value depends on the attempt finishing,
 * and whatever it leaves behind is one of the three stages.
 *
 * ## Nothing here logs a secret
 *
 * The account id, the public key and transaction hashes are logged: they are public by
 * construction, and they are what makes a log line checkable. The sealed envelope, the
 * data key and the seed never appear - `SealedAccount` is passed by reference and never
 * interpolated - and the errors caught here are the ones the lower layers already
 * stripped of detail.
 */
@Injectable()
export class AccountProvisioningService {
  private readonly logger = new Logger(AccountProvisioningService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    /**
     * The read half of the network, and only that: the account load that says whether a
     * row's account exists yet and whether it trusts USDC. Funding and signing stay where
     * they were - the funder port and `UsdcTrustlineService` - so nothing here reaches the
     * network itself.
     */
    private readonly stellar: StellarService,
    private readonly custody: SeedCustodyService,
    private readonly trustline: UsdcTrustlineService,
    @Inject(ACCOUNT_FUNDER) private readonly funder: AccountFunder,
    config: ConfigService,
  ) {
    this.timeoutMs = config.getOrThrow<number>('stellar.provisioningTimeoutMs');
  }

  /**
   * Makes sure `userId` has a funded, USDC-ready account, and reports what it did.
   *
   * Safe to call more than once, and *resumable*: a user whose row exists but whose
   * account was never finished - the funder refused it, the trustline was rejected, or the
   * deadline fired and the attempt still running then failed - is completed by this call
   * rather than reported as done. What is still missing is read from Horizon, so a
   * *finished* account costs one read and nothing else: no funder request, no transaction,
   * no key material touched, `already-provisioned`. Both are what make this usable from a
   * retry path (an operator's script) and not only from registration.
   *
   * **What this does not do is call itself.** Nothing in the app is scheduled or queued -
   * `AuthService.verifyOtp` is the only caller, and there is no queue consumer or cron to
   * be a second one (see `WalletModule`) - so an attempt that failed *after* its deadline
   * was reported (the work carried on in the background and then failed, with its outcome
   * dropped) stays stranded until something calls this again. Resuming is now possible;
   * retrying is still not automatic, and that is the part left open.
   */
  async provisionFor(userId: string): Promise<ProvisioningOutcome> {
    try {
      return await withDeadline(this.provision(userId), this.timeoutMs);
    } catch (cause) {
      // Reached for the deadline and for anything the stages did not anticipate.
      const detail = describeError(cause);

      this.logger.error(`Provisioning failed for user ${userId}: ${detail}`, errorStack(cause));

      return {
        status: 'incomplete',
        stage: undefined,
        accountId: undefined,
        publicKey: undefined,
        detail,
      };
    }
  }

  /**
   * The sequence itself.
   *
   * Failures a stage can classify are turned into an outcome here; anything else is
   * deliberately left to propagate to `provisionFor`, which is the one place that
   * knows it cannot let an exception out.
   *
   * ## A row that exists is resumed, not reported as finished
   *
   * The row is what makes an interrupted attempt resumable, so finding one is the *start*
   * of the work rather than the end of it: this method asks Horizon which of the two steps
   * after the insert are still missing and does those. It used to return
   * `already-provisioned` on the row alone, which meant an account that was stored but
   * never funded, or funded but never trusted, could not be finished by anyone - the two
   * layers below were built to be repeated and were simply never reached (see the
   * `funding` stage above, and `UsdcTrustlineService`'s "repeating it is safe").
   *
   * The check is a *read*, so a repeat call costs one account load, and it is what keeps
   * `already-provisioned` honest: the database cannot answer this question, because a row
   * is written *before* the account exists on the network and a failed attempt leaves it
   * behind on purpose.
   */
  private async provision(userId: string): Promise<ProvisioningOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneVerifiedAt: true,
        /**
         * Four columns rather than two: a row that already exists is resumed, and resuming
         * it means handing `ensureFor` the row whose seed it opens. They arrive on the read
         * that was happening anyway.
         */
        stellarAccount: {
          select: { id: true, publicKey: true, encryptedSecretKey: true, dataKeyArn: true },
        },
      },
    });

    if (user === null) {
      return this.failure(undefined, { userId }, new Error('The user does not exist'));
    }

    if (user.phoneVerifiedAt === null) {
      // Unreachable from `verifyOtp`, which writes that column in the transaction
      // before calling this. Kept because the cost of being wrong is an account for a
      // number nobody has proven they own, and the cost of the check is one branch.
      //
      // Checked *before* the row branch, where it used to sit after it: that branch now
      // funds and signs for a half-provisioned account, and "the number was never
      // verified" is exactly the reason not to. The one behaviour that changes is a user
      // who is both unverified and has a row - a refusal instead of `already-provisioned`
      // - which no flow in the app can produce, since the column is written before this is
      // called.
      return this.failure(
        undefined,
        { userId },
        new Error('The phone number is not verified'),
        'warn',
      );
    }

    const existing = user.stellarAccount;

    /**
     * Whether the account is already on the ledger: false for a keypair that was sealed
     * moments ago, Horizon's own answer for a row that was already there. It is what
     * decides whether the funder runs at all, so an account is funded at most once in its
     * lifetime rather than at most once per attempt.
     */
    let funded = false;

    /**
     * The row, before the value. `account` is the *created* row rather than the four
     * pieces it was created from, so the trustline step below is handed exactly the
     * columns it selects - there is no second place where the envelope and its ARN
     * could be paired up incorrectly.
     */
    let account: TrustlineAccountRow;

    if (existing === null) {
      try {
        const sealed = await this.custody.createSealedAccount();

        account = await this.prisma.stellarAccount.create({
          data: {
            id: sealed.accountId,
            userId,
            publicKey: sealed.publicKey,
            encryptedSecretKey: sealed.encryptedSecretKey,
            dataKeyArn: sealed.dataKeyArn,
          },
          select: { id: true, publicKey: true, encryptedSecretKey: true, dataKeyArn: true },
        });
      } catch (cause) {
        if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
          return this.concurrentAttempt(userId);
        }

        return this.failure('storage', { userId }, cause);
      }
    } else {
      /**
       * What the row's account still needs, read from Horizon. A load that *resolves* is
       * the account existing on the network; a `404` is Horizon saying the row is ahead of
       * the ledger, which is the normal state for an attempt that stopped before funding,
       * since a Stellar account exists from its first funding transaction onwards. Either
       * answer is work this call can finish, and the steps below are by design safe to
       * arrive at from here - which is the whole point of resuming instead of returning.
       */
      let outstanding: { readonly funded: boolean; readonly trusted: boolean };

      try {
        outstanding = await this.outstandingFor(existing.publicKey);
      } catch (cause) {
        // Not a 404: Horizon did not answer at all. Nothing about this account is known,
        // so nothing about it is asserted - and `StellarAccountSourceError`'s own contract
        // is that no account is provisioned on the strength of a failed lookup. Reported as
        // `warn` because a repeat of *this* call is what fixes it.
        return this.failure(
          'funding',
          { userId, accountId: existing.id, publicKey: existing.publicKey },
          cause,
        );
      }

      if (outstanding.funded && outstanding.trusted) {
        this.logger.log(
          `Stellar account already provisioned for user ${userId} ` +
            `(account ${existing.id}): funded and trusting USDC`,
        );

        return {
          status: 'already-provisioned',
          accountId: existing.id,
          publicKey: existing.publicKey,
        };
      }

      this.logger.log(
        `Resuming provisioning for user ${userId} (account ${existing.id}): ` +
          (outstanding.funded ? 'funded, but no USDC trustline' : 'not on the network yet'),
      );

      account = existing;
      funded = outstanding.funded;
    }

    let funding: FundingResult;

    if (funded) {
      // Not a funder that answered "already funded": no funder was asked. The XLM is there
      // from an earlier attempt, and `already-funded` is what that is - the caller's
      // question is "does this account have XLM now", and Horizon has just answered it.
      // There is no hash to name, which `FundingResult` already documents as the shape of a
      // success with no transaction of the funder's behind it.
      funding = ALREADY_FUNDED;
    } else {
      try {
        funding = await this.funder.fund(account.publicKey);
      } catch (cause) {
        return this.failure(
          'funding',
          { userId, accountId: account.id, publicKey: account.publicKey },
          cause,
        );
      }
    }

    let trustline: SubmittedTransaction;

    try {
      trustline = await this.trustline.ensureFor(account);
    } catch (cause) {
      return this.failure(
        'trustline',
        { userId, accountId: account.id, publicKey: account.publicKey },
        cause,
      );
    }

    this.logger.log(
      `Provisioned account ${account.publicKey} for user ${userId}: ` +
        (funded
          ? 'funding skipped (Horizon reports the account already on the network)'
          : `funded via ${this.funder.kind} (${funding.outcome}` +
            `${funding.transactionHash === undefined ? '' : ` ${funding.transactionHash}`})`) +
        `, trustline ${trustline.hash}`,
    );

    return {
      status: 'provisioned',
      accountId: account.id,
      publicKey: account.publicKey,
      funding: funding.outcome,
      fundingTransactionHash: funding.transactionHash,
      trustlineTransactionHash: trustline.hash,
    };
  }

  /**
   * What Horizon says an account that already has a row still needs.
   *
   * One load answers both remaining questions, which is why it is one method: a *resolved*
   * load is the account existing on the ledger at all - so `StellarAccountNotFoundError` is
   * Horizon saying the row is ahead of the network rather than an outage - and the trustline
   * is whether one of the lines that came back is the USDC line this app establishes.
   * `loadBalances` takes no account lock, deliberately, so this read does not queue behind
   * an in-flight transaction for the same account.
   *
   * Everything except the 404 propagates to the caller, which turns it into an `incomplete`
   * outcome: a Horizon that did not answer says *nothing* about the account, and
   * `StellarAccountSourceError`'s contract is that no account is provisioned on the
   * strength of a failed lookup.
   */
  private async outstandingFor(
    publicKey: string,
  ): Promise<{ readonly funded: boolean; readonly trusted: boolean }> {
    let lines: readonly StellarBalanceLine[];

    try {
      lines = await this.stellar.loadBalances(publicKey);
    } catch (cause) {
      if (cause instanceof StellarAccountNotFoundError) {
        return { funded: false, trusted: false };
      }

      throw cause;
    }

    // The asset comparison stays with the asset: `isUsdcLine` is `UsdcTrustlineService`'s
    // own answer to "is this line the trustline I create", so this flow never restates the
    // code or the issuer it is looking for.
    return { funded: true, trusted: lines.some((line) => this.trustline.isUsdcLine(line)) };
  }

  /**
   * A second attempt that lost the race to write the row.
   *
   * The `@unique` on `userId` is what makes provisioning single-writer, and losing
   * that race is not a failure: an account for this user exists, which is what the
   * caller asked for, and the winner is responsible for funding it. Re-reading is how
   * this call finds out the winner's account id rather than inventing one - and
   * *not* re-reading (assuming the row it just tried to insert) is how a caller would
   * end up logging a public key that is not the one stored.
   *
   * This is the one place a row is *not* resumed, and deliberately: the winner is
   * provisioning that account right now. A probe here would read "not on the network yet" -
   * the winner has not funded it either - and ask the funder for a starting balance while
   * the winner does the same, on the endpoint that pays repeats. The winner owns funding;
   * if it then fails, the row it wrote is what a *later* call resumes, which is the path
   * `provision` now takes.
   */
  private async concurrentAttempt(userId: string): Promise<ProvisioningOutcome> {
    const existing = await this.prisma.stellarAccount.findUnique({
      where: { userId },
      select: { id: true, publicKey: true },
    });

    if (existing === null) {
      // A `P2002` on `publicKey` (rather than on `userId`) lands here, as would a row
      // deleted between the two statements. Both are "the conflict was not what we
      // thought", and pretending otherwise would mean reporting an account that this
      // process has no evidence of.
      return this.failure(
        'storage',
        { userId },
        new Error('The account row was not found after a unique-index conflict'),
      );
    }

    this.logger.log(
      `Stellar account already provisioned for user ${userId} (account ${existing.id}), concurrently`,
    );

    return { status: 'already-provisioned', accountId: existing.id, publicKey: existing.publicKey };
  }

  /**
   * Turns a classified failure into the `incomplete` outcome, and logs it at the level
   * its reaction deserves: `warn` for the failures a retry can clear, `error` for the
   * ones that need a human. The distinction is the whole reason the lower layers
   * separate "unavailable" from "misconfigured"/"rejected", and it is lost the moment
   * both are logged the same way.
   */
  private failure(
    stage: ProvisioningStage | undefined,
    context: { userId: string; accountId?: string; publicKey?: string },
    cause: unknown,
    level: 'warn' | 'error' = logLevelFor(cause),
  ): ProvisioningOutcome {
    const detail = describeError(cause);
    const where = [
      stage === undefined ? undefined : `stage ${stage}`,
      context.accountId === undefined ? undefined : `account ${context.accountId}`,
      `user ${context.userId}`,
    ]
      .filter((part) => part !== undefined)
      .join(', ');

    if (level === 'warn') {
      this.logger.warn(`Provisioning incomplete (${where}): ${detail}`);
    } else {
      this.logger.error(`Provisioning incomplete (${where}): ${detail}`, errorStack(cause));
    }

    return {
      status: 'incomplete',
      stage,
      accountId: context.accountId,
      publicKey: context.publicKey,
      detail,
    };
  }
}

/**
 * The funding step's report when there was no funding step.
 *
 * A resumed account is funded *by an earlier attempt*, so no funder is asked and there is
 * no transaction of this call's to name. `already-funded` is exactly what `FundingResult`
 * defines for "the account has XLM and no funder payment came from here", and this is a
 * constant rather than a literal at the call site so that "no funder was asked" has one
 * definition - and so a spec can assert the object a resumed account reports.
 */
const ALREADY_FUNDED: FundingResult = { outcome: 'already-funded', transactionHash: undefined };

/**
 * Raised by `withDeadline` when the flow ran out of time.
 *
 * A class of its own so the outer catch can tell "we stopped waiting" apart from "the
 * code threw" without matching on a message.
 */
class ProvisioningDeadlineExceededError extends Error {
  constructor(timeoutMs: number) {
    super(`The flow did not finish within ${timeoutMs} ms (STELLAR_PROVISIONING_TIMEOUT_MS)`);
    this.name = 'ProvisioningDeadlineExceededError';
  }
}

/**
 * Rejects with `ProvisioningDeadlineExceededError` if `work` has not settled within
 * `timeoutMs`.
 *
 * The timer is cleared as soon as `work` settles and `unref`'d, so a pending deadline
 * never keeps the process alive (which matters for graceful shutdown, and for a spec
 * that would otherwise hang on a fake funder that never answers).
 *
 * Losing the race does not cancel `work`: the handlers attached here stay attached, so
 * a late rejection is *observed* - it cannot become an unhandled rejection and take the
 * process down - and a late success is simply dropped.
 */
function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProvisioningDeadlineExceededError(timeoutMs)),
      timeoutMs,
    );

    timer.unref();

    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * The log level a classified failure deserves.
 *
 * `warn` for the three "unavailable" errors, whose whole meaning is "nothing happened, a
 * retry can still succeed" - the states that must be *retried*, not alarmed about: a funder
 * that did not answer, a submission with no verdict, and a Horizon that could not load an
 * account (`StellarAccountSourceError`, which resuming a row reads through).
 * `error` for everything else: a misconfiguration, a rejected transaction, or a bug,
 * none of which a retry clears and all of which want a human.
 */
function logLevelFor(cause: unknown): 'warn' | 'error' {
  return cause instanceof AccountFundingUnavailableError ||
    cause instanceof StellarSubmissionUnavailableError ||
    cause instanceof StellarAccountSourceError
    ? 'warn'
    : 'error';
}

/** A one-line description of a failure, for a log line. */
function describeError(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') {
    return `${cause.name}: ${cause.message}`;
  }

  return 'unknown failure';
}

/** The stack, when there is one: `Error` subclasses from the SDK all carry it. */
function errorStack(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.stack : undefined;
}
