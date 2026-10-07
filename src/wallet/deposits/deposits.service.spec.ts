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

/**
 * One row in the fake `transactions` table, as the dedup sees it: the hash this app recorded and
 * the two users it moved money between.
 */
interface RecordedRow {
  stellarTxHash: string | null;
  senderId: string;
  recipientId: string;
}

/** The `where` the service built for the dedup read, for the tests that assert on it. */
interface RecordedQuery {
  where: {
    stellarTxHash: { in: readonly string[] };
    OR: ReadonlyArray<{ senderId?: string; recipientId?: string }>;
  };
}

function createHarness(
  options: {
    account?: { publicKey: string } | null;
    page?: IncomingPaymentPage;
    error?: Error;
    /** Rows the app has in `transactions`. The fake applies the service's real `where` to them. */
    rows?: readonly RecordedRow[];
  } = {},
) {
  const account = options.account === undefined ? { publicKey: 'GPUBLIC-KEY' } : options.account;
  const calls: Array<{ accountId: string; options: { limit: number; cursor?: string } }> = [];
  const queries: RecordedQuery[] = [];
  const rows = options.rows ?? [];

  const prisma = {
    stellarAccount: { findUnique: async () => account },
    transaction: {
      // A miniature of the query rather than a canned answer: it honours both halves of the
      // `where` (the hashes asked about *and* the caller scoping), so a test that changes either
      // one changes what comes back.
      findMany: async (args: RecordedQuery) => {
        queries.push(args);

        const { in: hashes } = args.where.stellarTxHash;
        const parties = args.where.OR;

        return rows
          .filter(
            (row) =>
              row.stellarTxHash !== null &&
              hashes.includes(row.stellarTxHash) &&
              parties.some(
                (party) =>
                  party.senderId === row.senderId || party.recipientId === row.recipientId,
              ),
          )
          .map((row) => ({ stellarTxHash: row.stellarTxHash }));
      },
    },
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

  return { service: new DepositsService(prisma, stellar, trustline), calls, queries };
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

  it('suppresses a deposit this app moved for the caller, keeping Horizon’s cursor', async () => {
    const { service, queries } = createHarness({
      page: {
        payments: [
          payment({ id: '1', pagingToken: '1', transactionHash: 'hash-internal' }),
          payment({ id: '2', pagingToken: '2', transactionHash: 'hash-outside' }),
        ],
        nextCursor: '2',
      },
      // The app built the first payment and this user is its recipient, so it is already on
      // `GET /v1/payments` as a received payment - reporting it here too would count the same
      // money twice on two screens a client reads side by side.
      rows: [{ stellarTxHash: 'hash-internal', senderId: 'user-2', recipientId: 'user-1' }],
    });

    const response = await service.listFor('user-1', {});

    expect(response.items.map((item) => item.transactionHash)).toEqual(['hash-outside']);
    // The cursor is Horizon's, taken from the *full* page: the hidden row is still paged past, so
    // it can neither be fetched again by a client following `nextCursor` nor shift a newer deposit
    // out of the window.
    expect(response.nextCursor).toBe('2');
    // One question, about the hashes that survived the asset filter, and scoped to the caller.
    expect(queries[0].where).toEqual({
      stellarTxHash: { in: ['hash-internal', 'hash-outside'] },
      OR: [{ senderId: 'user-1' }, { recipientId: 'user-1' }],
    });
  });

  it('does not suppress a hash that belongs to two other users', async () => {
    const { service } = createHarness({
      page: {
        payments: [payment({ id: '1', transactionHash: 'hash-others' })],
        nextCursor: null,
      },
      // A row exists, but the caller is neither party: this is someone else's transfer, which the
      // caller has never seen on `/v1/payments`, so Horizon is right to show it as a deposit.
      rows: [{ stellarTxHash: 'hash-others', senderId: 'user-2', recipientId: 'user-3' }],
    });

    const response = await service.listFor('user-1', {});

    expect(response.items.map((item) => item.transactionHash)).toEqual(['hash-others']);
  });

  it('does not ask the database when the page holds no USDC deposit', async () => {
    const { service, queries } = createHarness({
      page: {
        payments: [
          payment({ id: '1', assetCode: null, assetIssuer: null }),
          payment({ id: '2', assetIssuer: 'GSOMEONE-ELSE' }),
        ],
        nextCursor: null,
      },
    });

    await service.listFor('user-1', {});

    // Nothing on this page would be shown, so nothing is worth a `transactions` lookup.
    expect(queries).toEqual([]);
  });
});
