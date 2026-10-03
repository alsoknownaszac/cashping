import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Amount } from '../../common/money/amount.js';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { readBalances } from '../../wallet/balances/balance-lines.js';
import { UsdcTrustlineService } from '../../wallet/provisioning/usdc-trustline.js';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
} from '../../wallet/stellar/account-source.js';
import { StellarService } from '../../wallet/stellar/stellar.service.js';
import { type LedgerQueueReconciliationResult } from '../jobs/ledger-queue.js';
import { reconcileAccount } from '../reconciliation/reconciliation.js';

/** Zero, used for an account whose rows sum to nothing and for one Horizon reported no line for. */
const ZERO = Amount.fromString('0');

/**
 * How many accounts one tick reconciles.
 *
 * A bound rather than "all of them", for the reason `CONFIRMATION_SWEEP_BATCH` records on the
 * payments side: a tick's duration is (accounts × Horizon latency), so an unbounded sweep would hold
 * the worker for as long as the table is wide and delay whatever else is queued. Accounts are taken
 * oldest-first so a backlog is worked through in a stable order, and the rest arrive on the next
 * tick. At the MVP's scale every account fits in one tick, which is the state this bound is sized for.
 */
export const RECONCILIATION_SWEEP_BATCH = 50;

/** The `stellar_accounts` columns one account is reconciled with - the sweep query's `select`. */
interface ReconciledAccount {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: string;
}

/** What one sweep reports - re-exported so the processor and the job's result type cannot drift. */
export type ReconciliationSweepResult = LedgerQueueReconciliationResult;

/**
 * The reconciliation sweep (Step 31): the internal ledger, checked against the network.
 *
 * ## What it compares
 *
 * For every Stellar account this app custodies, it puts **the sum of the USDC this app has recorded
 * moving through that account** (`SUCCESSFUL` transactions only - see `reconciliation.ts` for why)
 * beside **the USDC balance Horizon reports for it right now**, and raises a drift when the two are
 * not equal. The comparison is exact rather than approximate because both sides are 7-decimal
 * strings: no tolerance is subtracted, because a tolerance is a number somebody has to defend, and
 * the one thing this job exists to notice is money that has quietly stopped adding up.
 *
 * ## Where the answer goes
 *
 * A `logger.error` line per drifted account names the public key, so an operator reading logs during
 * an incident sees it without opening Sentry; and `Sentry.captureMessage` carries the account id, the
 * user id, both balances and the drift as structured fields. This is the *only* thing in the app that
 * reports a non-exception condition to Sentry (the global filter reports 5xx responses), and it is
 * deliberate: a drift is not a failed request, it is a fact about money that no user's request would
 * ever surface.
 *
 * ## What it does *not* do
 *
 * It never writes. There is nothing in this schema to write a drift *to* - the append-only audit log
 * (Step 32) records actions, not balances - and a job that "corrected" a balance would be guessing at
 * which side was wrong. It reads, it reports, and a human decides.
 *
 * It also does not reconcile native XLM: see `reconciliation.ts` for why the settlement asset is the
 * only balance an internal sum can be expected to predict.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The wallet module's one door to Horizon - see `StellarService`'s docstring. */
    private readonly stellar: StellarService,
    /** Which USDC this deployment is paid in: the one definition the trustline was created from. */
    private readonly trustline: UsdcTrustlineService,
  ) {}

  /**
   * One reconciliation tick: every account in the batch, compared and reported.
   *
   * Resolves with the counters the job stores as its result, and never throws for a Horizon that did
   * not answer - an unreachable network is a value the sweep counts (`unavailable`), not an exception
   * that would fail the job and hide the accounts that *were* reconciled.
   */
  async sweep(): Promise<ReconciliationSweepResult> {
    const asset = this.trustline.assetIdentity();

    const accounts = await this.prisma.stellarAccount.findMany({
      // Three columns, because that is all a comparison needs: the key to ask Horizon about and the
      // ids that name the account and its owner. The envelope and its ARN are deliberately not
      // selected - reconciliation has no business loading key material into this process.
      select: { id: true, userId: true, publicKey: true },
      orderBy: { createdAt: 'asc' },
      take: RECONCILIATION_SWEEP_BATCH,
    });

    const net = await this.internalNet(accounts.map((account) => account.userId));

    const tally = {
      accounts: accounts.length,
      compared: 0,
      matched: 0,
      drifted: 0,
      unavailable: 0,
    };

    for (const account of accounts) {
      const internalNet = net.get(account.userId) ?? ZERO;

      const horizonUsdc = await this.horizonUsdc(account, asset);

      if (horizonUsdc === UNANSWERED) {
        tally.unavailable += 1;
        continue;
      }

      tally.compared += 1;

      const outcome = reconcileAccount(internalNet, horizonUsdc);

      if (outcome.verdict === 'matched') {
        tally.matched += 1;
        continue;
      }

      tally.drifted += 1;
      this.reportDrift(account, internalNet, horizonUsdc, outcome.drift);
    }

    this.logger.log(
      `Reconciliation: ${tally.compared}/${tally.accounts} compared, ${tally.matched} matched, ${tally.drifted} drifted, ${tally.unavailable} unavailable`,
    );

    return tally;
  }

  /**
   * The USDC line Horizon reports for one account.
   *
   * `null` means "no USDC line", which reconciliation reads as zero - the account cannot receive
   * USDC, so any internal sum above zero is a drift. `UNANSWERED` is the third answer and means
   * Horizon did not reply at all: the account is counted and left out of the comparison, because
   * "could not ask" and "the answer is zero" are opposite facts and only one of them is a drift.
   */
  private async horizonUsdc(
    account: ReconciledAccount,
    asset: ReturnType<UsdcTrustlineService['assetIdentity']>,
  ): Promise<string | null | typeof UNANSWERED> {
    try {
      const lines = await this.stellar.loadBalances(account.publicKey);

      return readBalances(lines, asset).usdc.balance;
    } catch (cause) {
      /**
       * The row is ahead of the ledger: provisioning sealed the key but the funding never completed,
       * so the network has never seen this account. That is a *zero* balance rather than an unknown
       * one, and reconciliation treats it as such - if the records claim this account received
       * money, the missing account is exactly the drift worth reporting.
       */
      if (cause instanceof StellarAccountNotFoundError) {
        return null;
      }

      /**
       * Horizon did not answer. Nothing may be concluded, so nothing is: the account is counted as
       * unavailable. A bug or an unclassified failure keeps travelling, to the global filter and
       * Sentry, rather than being reshaped into a balance.
       */
      if (cause instanceof StellarAccountSourceError) {
        this.logger.warn(`Reconciliation could not read ${account.publicKey}: ${cause.message}`);

        return UNANSWERED;
      }

      throw cause;
    }
  }

  /**
   * The internal net for many users in two queries, as a map keyed by user id.
   *
   * Two `groupBy` calls rather than a query per account, because the work is "sum per user" and the
   * database does that far better than a loop of `aggregate`s would. The sums are turned into
   * `Amount` through `fromDatabase` and *subtracted* - never added in JavaScript - which is why the
   * inflow and outflow are kept apart until the one operation `Amount` offers: the net is
   * `inflow.minus(outflow)`, and no 7-decimal value is ever reconstructed by hand.
   */
  private async internalNet(userIds: readonly string[]): Promise<Map<string, Amount>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const ids = [...userIds];

    const [received, sent] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['recipientId'],
        where: { recipientId: { in: ids }, status: TransactionStatus.SUCCESSFUL },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['senderId'],
        where: { senderId: { in: ids }, status: TransactionStatus.SUCCESSFUL },
        _sum: { amount: true },
      }),
    ]);

    const inflow = new Map(
      received.map((row) => [row.recipientId, sumOf(row._sum.amount)] as const),
    );
    const outflow = new Map(sent.map((row) => [row.senderId, sumOf(row._sum.amount)] as const));

    return new Map(
      userIds.map((userId) => [
        userId,
        (inflow.get(userId) ?? ZERO).minus(outflow.get(userId) ?? ZERO),
      ]),
    );
  }

  /**
   * Logs a drift and reports it to Sentry.
   *
   * Both halves name the same three things - which account, what these records say, what the network
   * says - because that is the entire content of the finding, and an alert that left any of them out
   * would only produce a second query somebody has to run by hand during an incident.
   */
  private reportDrift(
    account: ReconciledAccount,
    internalNet: Amount,
    horizonUsdc: string | null,
    drift: Amount,
  ): void {
    const horizonText = horizonUsdc ?? '0.0000000';

    this.logger.error(
      `Reconciliation drift for ${account.publicKey}: internal net ${internalNet.toString()} USDC, Horizon ${horizonText} USDC, drift ${drift.toString()} USDC`,
    );

    Sentry.captureMessage(
      `Reconciliation drift of ${drift.toString()} USDC for Stellar account ${account.publicKey}`,
      {
        level: 'error',
        tags: { area: 'reconciliation' },
        extra: {
          accountId: account.id,
          userId: account.userId,
          publicKey: account.publicKey,
          internalNet: internalNet.toString(),
          horizonUsdc: horizonText,
          drift: drift.toString(),
        },
      },
    );
  }
}

/**
 * A sentinel distinct from the `null` USDC-balance answer.
 *
 * `horizonUsdc` has three possible answers and two of them are `null`-shaped, so it cannot be typed
 * as `string | null`: "no USDC line" (a value: zero) and "Horizon did not answer" (not a value at
 * all) demand opposite reactions, and only an extra sentinel keeps them apart. It never leaves the
 * service.
 */
const UNANSWERED = Symbol('reconciliation-unanswered');

/** A `_sum.amount` from a `groupBy`, or zero when the group is empty (which sums to `null`). */
function sumOf(value: { toString(): string } | null): Amount {
  return value === null ? ZERO : Amount.fromDatabase(value);
}
