import { type ConfigService } from '@nestjs/config';
import { NotFoundError } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { type HorizonServer } from './horizon-account-source.js';
import { HorizonPaymentsLookup } from './horizon-payments-lookup.js';
import { StellarPaymentsLookupError } from './payments-lookup.js';

/**
 * The mapping from Horizon's payments page into the port's shape, faked at the server factory
 * exactly as the other two Horizon ports' specs do it.
 *
 * The three things worth pinning are the ones a caller depends on: only payments *into* the
 * account survive the filter (a `forAccount` page mixes both directions and non-payment
 * operations), the fields come across unmodified, and a Horizon that did not answer is an error
 * rather than an empty page - because "no deposits" and "we could not ask" call for opposite
 * things in front of a user.
 */

const ACCOUNT = 'GDHU2YQBJ4O3G6FQMVBBMGX7RB6XQW6QMVBBMGX7RB6XQW6QMVBBMGX7RB6';

/** A Horizon operation record, as the SDK returns one, with the fields this class reads. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    paging_token: '1',
    created_at: '2026-10-05T09:14:03Z',
    transaction_hash: 'hash-1',
    type: 'payment',
    from: 'GSENDER-ACCOUNT',
    to: ACCOUNT,
    amount: '25.0000000',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GISSUER-ACCOUNT',
    ...overrides,
  };
}

/** The class over a fake Horizon: the page to answer with, the hosts asked for, the queries run. */
function lookupOver(answer: readonly Record<string, unknown>[] | Error) {
  const hosts: string[] = [];
  const calls: Array<{ account: string; limit: number; cursor?: string }> = [];

  const server = {
    payments: () => {
      let account = '';
      let limit = 0;
      let cursor: string | undefined;

      const builder = {
        forAccount: (id: string): typeof builder => {
          account = id;

          return builder;
        },
        order: (): typeof builder => builder,
        limit: (count: number): typeof builder => {
          limit = count;

          return builder;
        },
        cursor: (token: string): typeof builder => {
          cursor = token;

          return builder;
        },
        call: async (): Promise<{ records: Record<string, unknown>[] }> => {
          calls.push({ account, limit, cursor });

          if (answer instanceof Error) {
            throw answer;
          }

          return { records: [...answer] };
        },
      };

      return builder;
    },
  } as unknown as HorizonServer;

  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'stellar.horizonUrl') {
        throw new Error(`unexpected config key ${key}`);
      }

      return 'https://horizon-testnet.stellar.org';
    },
  } as unknown as ConfigService;

  const createServer = (host: string): HorizonServer => {
    hosts.push(host);

    return server;
  };

  return { lookup: new HorizonPaymentsLookup(config, createServer), hosts, calls };
}

describe('HorizonPaymentsLookup', () => {
  it('keeps only the payments into the account, and maps their fields unmodified', async () => {
    const { lookup } = lookupOver([
      record(),
      // Outgoing: a payment where the account is the sender, not the receiver.
      record({ id: '2', paging_token: '2', from: ACCOUNT, to: 'GSOMEONE-ELSE' }),
      // Not a payment at all: a `create_account` has no `to` and no `amount`.
      record({
        id: '3',
        paging_token: '3',
        to: undefined,
        amount: undefined,
        type: 'create_account',
      }),
    ]);

    const page = await lookup.listIncoming(ACCOUNT, { limit: 20 });

    expect(page.payments).toEqual([
      {
        id: '1',
        pagingToken: '1',
        createdAt: '2026-10-05T09:14:03Z',
        transactionHash: 'hash-1',
        from: 'GSENDER-ACCOUNT',
        amount: '25.0000000',
        assetCode: 'USDC',
        assetIssuer: 'GISSUER-ACCOUNT',
      },
    ]);
  });

  it('reports a native payment with a null asset', async () => {
    const { lookup } = lookupOver([
      record({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined }),
    ]);

    const page = await lookup.listIncoming(ACCOUNT, { limit: 20 });

    expect(page.payments[0]).toMatchObject({ assetCode: null, assetIssuer: null });
  });

  it("sets nextCursor to the last payment's token, and null when the page is empty", async () => {
    const { lookup } = lookupOver([
      record({ id: '9', paging_token: '900' }),
      record({ id: '8', paging_token: '800' }),
    ]);

    await expect(lookup.listIncoming(ACCOUNT, { limit: 20 })).resolves.toMatchObject({
      nextCursor: '800',
    });

    const empty = lookupOver([]);
    await expect(empty.lookup.listIncoming(ACCOUNT, { limit: 20 })).resolves.toEqual({
      payments: [],
      nextCursor: null,
    });
  });

  it("treats Horizon's 404 as an empty page, not an error", async () => {
    // A wallet that is not on the ledger yet has no deposits, which is an answer.
    const { lookup } = lookupOver(
      new NotFoundError('Account not found', { status: 404, statusText: 'Not Found' }),
    );

    await expect(lookup.listIncoming(ACCOUNT, { limit: 20 })).resolves.toEqual({
      payments: [],
      nextCursor: null,
    });
  });

  it('reports a Horizon that did not answer as an error, so it cannot read as "no deposits"', async () => {
    const { lookup } = lookupOver(new Error('ETIMEDOUT'));

    await expect(lookup.listIncoming(ACCOUNT, { limit: 20 })).rejects.toBeInstanceOf(
      StellarPaymentsLookupError,
    );
  });

  it('passes the limit and cursor through, and builds one client from the configured host', async () => {
    const { lookup, hosts, calls } = lookupOver([record()]);

    await lookup.listIncoming(ACCOUNT, { limit: 5 });
    await lookup.listIncoming(ACCOUNT, { limit: 5, cursor: '77' });

    expect(hosts).toEqual(['https://horizon-testnet.stellar.org']);
    expect(calls).toEqual([
      { account: ACCOUNT, limit: 5, cursor: undefined },
      { account: ACCOUNT, limit: 5, cursor: '77' },
    ]);
  });
});
