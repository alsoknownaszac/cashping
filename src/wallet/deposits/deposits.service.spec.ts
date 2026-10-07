import { describe, expect, it } from 'vitest';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type UsdcTrustlineService } from '../provisioning/usdc-trustline.js';
import {
  StellarPaymentsLookupError,
  type IncomingPaymentPage,
  type IncomingStellarPayment,
} from '../stellar/payments-lookup.js';
import { type StellarService } from '../stellar/stellar.service.js';
import { DepositsService } from './deposits.service.js';

/**
 * The deposits read's four decisions, against a fake Prisma, a fake Horizon and the real asset
 * identity: the account row names the key, the page is filtered to this deployment's USDC by code
 * *and* issuer, an unreachable Horizon is a 503 rather than an empty list, and a bad query is a
 * 400. The ledger read itself is `horizon-payments-lookup.spec.ts`'s subject.
 */

/** The asset this deployment pays in - the pair the filter matches. */
const ASSET = { code: 'USDC', issuer: 'GISSUER-ACCOUNT' };

function payment(overrides: Partial<IncomingStellarPayment> = {}): IncomingStellarPayment {
  return {
    id: '1',
    pagingToken: '1',
    createdAt: '2026-10-05T09:14:03Z',
    transactionHash: 'hash-1',
    from: 'GSENDER-ACCOUNT',
    amount: '25.0000000',
    assetCode: ASSET.code,
    assetIssuer: ASSET.issuer,
    ...overrides,
  };
}

function createHarness(
  options: {
    account?: { publicKey: string } | null;
    page?: IncomingPaymentPage;
    error?: Error;
  } = {},
) {
  const account = options.account === undefined ? { publicKey: 'GPUBLIC-KEY' } : options.account;
  const calls: Array<{ accountId: string; options: { limit: number; cursor?: string } }> = [];

  const prisma = {
    stellarAccount: { findUnique: async () => account },
  } as unknown as PrismaService;

  const stellar = {
    listIncomingPayments: async (
      accountId: string,
      opts: { limit: number; cursor?: string },
    ): Promise<IncomingPaymentPage> => {
      calls.push({ accountId, options: opts });

      if (options.error !== undefined) {
        throw options.error;
      }

      return options.page ?? { payments: [], nextCursor: null };
    },
  } as unknown as StellarService;

  const trustline = { assetIdentity: () => ASSET } as unknown as UsdcTrustlineService;

  return { service: new DepositsService(prisma, stellar, trustline), calls };
}

describe('DepositsService.listFor', () => {
  it('answers 404 when the user has no wallet, before asking Horizon', async () => {
    const { service, calls } = createHarness({ account: null });

    await expect(service.listFor('user-1', {})).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);
  });

  it('reports the asset and maps the page, filtering to this USDC by code and issuer', async () => {
    const { service, calls } = createHarness({
      page: {
        payments: [
          payment({ id: '1', pagingToken: '1' }),
          // Wrong issuer: a `USDC` from another issuer is another asset, and is dropped.
          payment({ id: '2', pagingToken: '2', assetIssuer: 'GSOMEONE-ELSE' }),
          // Native: no code, no issuer, and not the product's money.
          payment({ id: '3', pagingToken: '3', assetCode: null, assetIssuer: null }),
        ],
        nextCursor: '3',
      },
    });

    const response = await service.listFor('user-1', {});

    expect(calls).toEqual([{ accountId: 'GPUBLIC-KEY', options: { limit: 20 } }]);
    expect(response.asset).toEqual(ASSET);
    expect(response.nextCursor).toBe('3');
    expect(response.items).toEqual([
      {
        id: '1',
        amount: '25.0000000',
        from: 'GSENDER-ACCOUNT',
        createdAt: '2026-10-05T09:14:03Z',
        transactionHash: 'hash-1',
      },
    ]);
  });

  it('answers 503 when Horizon could not be asked, rather than an empty list', async () => {
    const { service } = createHarness({
      error: new StellarPaymentsLookupError('GPUBLIC-KEY'),
    });

    await expect(service.listFor('user-1', {})).rejects.toMatchObject({ status: 503 });
  });

  it('answers 400 for a limit that is not a whole number, naming the parameter', async () => {
    const { service, calls } = createHarness();

    await expect(service.listFor('user-1', { limit: 'abc' })).rejects.toMatchObject({
      status: 400,
    });
    // Refused before the ledger read: a bad request does not cost a Horizon call.
    expect(calls).toEqual([]);
  });

  it('passes the parsed limit and cursor through to the port', async () => {
    const { service, calls } = createHarness();

    await service.listFor('user-1', { limit: '5', cursor: '77' });

    expect(calls).toEqual([
      { accountId: 'GPUBLIC-KEY', options: { limit: 5, cursor: '77' } },
    ]);
  });
});
