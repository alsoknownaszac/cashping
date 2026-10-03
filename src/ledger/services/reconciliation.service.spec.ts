import * as Sentry from '@sentry/nestjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type UsdcTrustlineService } from '../../wallet/provisioning/usdc-trustline.js';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
  type StellarBalanceLine,
} from '../../wallet/stellar/account-source.js';
import { type StellarService } from '../../wallet/stellar/stellar.service.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * The reconciliation sweep, with the forced-mismatch case Step 31's audit checklist asks for.
 *
 * `PrismaService` and `StellarService` are substituted rather than the ports below them, because the
 * decision under test is *this* layer's: which accounts it reads, how it sums their movements, and
 * what it does about the one answer that is a finding. The arithmetic itself is
 * `reconciliation.spec.ts`, and that a real Horizon reports a real balance is the wallet's own
 * suites. What is proved here is the half the audit cares about: **a deliberately-introduced drift is
 * detected and *alerted*** - `Sentry.captureMessage` is asserted, not the comparison alone.
 *
 * `vi.mock` replaces the Sentry module, so `captureMessage` is a spy and the real SDK is never
 * initialised.
 */

vi.mock('@sentry/nestjs', () => ({ captureMessage: vi.fn() }));

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const ACCOUNT = {
  id: '3c5a4b2e-0000-4000-8000-000000000001',
  userId: '1f0b7f2e-8f4a-4c2b-9d3e-5a6b7c8d9e0f',
  publicKey: 'GCEKPAYY2BODURJDT6V4YP2QPB27RQTPJMWB2T2EFXPGMHSFGX5Q7CUT',
};

/** One USDC line, as Horizon answers with it. */
function usdcLine(balance: string): StellarBalanceLine {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: ISSUER,
    balance,
    limit: '922337203685.4775807',
    is_authorized: true,
  };
}

interface Harness {
  readonly service: ReconciliationService;
  readonly groupBy: ReturnType<typeof vi.fn>;
  readonly loadBalances: ReturnType<typeof vi.fn>;
}

/**
 * One sweep, with the row, the recorded movements and Horizon's answer all under the test's control.
 *
 * `received`/`sent` are the `SUCCESSFUL` sums `groupBy` would return; `balance` is what Horizon
 * reports as USDC; `failure` is what Horizon did instead of answering.
 */
function harness(options: {
  received?: readonly { recipientId: string; amount: string }[];
  sent?: readonly { senderId: string; amount: string }[];
  balance?: string;
  failure?: Error;
}): Harness {
  const findMany = vi.fn().mockResolvedValue([ACCOUNT]);

  const groupBy = vi.fn().mockImplementation((args: { by: readonly string[] }) =>
    args.by[0] === 'recipientId'
      ? Promise.resolve(
          (options.received ?? []).map((row) => ({
            recipientId: row.recipientId,
            _sum: { amount: row.amount },
          })),
        )
      : Promise.resolve(
          (options.sent ?? []).map((row) => ({
            senderId: row.senderId,
            _sum: { amount: row.amount },
          })),
        ),
  );

  const loadBalances = options.failure
    ? vi.fn().mockRejectedValue(options.failure)
    : vi.fn().mockResolvedValue([usdcLine(options.balance ?? '0.0000000')]);

  const service = new ReconciliationService(
    { stellarAccount: { findMany }, transaction: { groupBy } } as unknown as PrismaService,
    { loadBalances } as unknown as StellarService,
    { assetIdentity: () => ({ code: 'USDC', issuer: ISSUER }) } as unknown as UsdcTrustlineService,
  );

  return { service, groupBy, loadBalances };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReconciliationService.sweep', () => {
  it('matches when the internal net equals the Horizon balance, and alerts nothing', async () => {
    const { service } = harness({
      received: [{ recipientId: ACCOUNT.userId, amount: '5' }],
      balance: '5.0000000',
    });

    await expect(service.sweep()).resolves.toEqual({
      accounts: 1,
      compared: 1,
      matched: 1,
      drifted: 0,
      unavailable: 0,
    });

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('subtracts what the account sent: the internal net is receipts less payments', async () => {
    const { service } = harness({
      received: [{ recipientId: ACCOUNT.userId, amount: '10' }],
      sent: [{ senderId: ACCOUNT.userId, amount: '4' }],
      balance: '6.0000000',
    });

    await expect(service.sweep()).resolves.toEqual({
      accounts: 1,
      compared: 1,
      matched: 1,
      drifted: 0,
      unavailable: 0,
    });
  });

  it('detects a forced drift and alerts Sentry with the account and both balances', async () => {
    const { service } = harness({
      received: [{ recipientId: ACCOUNT.userId, amount: '5' }],
      balance: '3.0000000',
    });

    await expect(service.sweep()).resolves.toEqual({
      accounts: 1,
      compared: 1,
      matched: 0,
      drifted: 1,
      unavailable: 0,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);

    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0] as [
      string,
      { level?: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
    ];

    expect(message).toContain('Reconciliation drift');
    expect(context.level).toBe('error');
    expect(context.tags).toEqual({ area: 'reconciliation' });
    expect(context.extra).toMatchObject({
      accountId: ACCOUNT.id,
      userId: ACCOUNT.userId,
      internalNet: '5',
      horizonUsdc: '3.0000000',
      drift: '-2',
    });
  });

  it('reports a drift when a payment is recorded but the account is not on the ledger at all', async () => {
    const { service } = harness({
      received: [{ recipientId: ACCOUNT.userId, amount: '5' }],
      failure: new StellarAccountNotFoundError(ACCOUNT.publicKey),
    });

    await expect(service.sweep()).resolves.toEqual({
      accounts: 1,
      compared: 1,
      matched: 0,
      drifted: 1,
      unavailable: 0,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('counts an unreachable Horizon as unavailable and concludes nothing', async () => {
    const { service } = harness({
      received: [{ recipientId: ACCOUNT.userId, amount: '5' }],
      failure: new StellarAccountSourceError(ACCOUNT.publicKey),
    });

    await expect(service.sweep()).resolves.toEqual({
      accounts: 1,
      compared: 0,
      matched: 0,
      drifted: 0,
      unavailable: 1,
    });

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does nothing at all when there are no accounts', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn();
    const loadBalances = vi.fn();

    const service = new ReconciliationService(
      { stellarAccount: { findMany }, transaction: { groupBy } } as unknown as PrismaService,
      { loadBalances } as unknown as StellarService,
      {
        assetIdentity: () => ({ code: 'USDC', issuer: ISSUER }),
      } as unknown as UsdcTrustlineService,
    );

    await expect(service.sweep()).resolves.toEqual({
      accounts: 0,
      compared: 0,
      matched: 0,
      drifted: 0,
      unavailable: 0,
    });

    expect(groupBy).not.toHaveBeenCalled();
    expect(loadBalances).not.toHaveBeenCalled();
  });
});
