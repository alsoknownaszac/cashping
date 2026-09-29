import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StellarNetwork } from '../../config/validation.schema.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type UsdcTrustlineService } from '../provisioning/usdc-trustline.js';
import {
  StellarAccountNotFoundError,
  StellarAccountSourceError,
  type StellarBalanceLine,
} from '../stellar/account-source.js';
import { type StellarService } from '../stellar/stellar.service.js';
import { BalancesService } from './balances.service.js';

/**
 * What the two wallet endpoints do with each answer the network can give (Step 20).
 *
 * `StellarService` and `PrismaService` are substituted rather than the ports below them,
 * because the decision under test is *this* layer's: which of four states a request is in
 * (no row, unfunded, funded, Horizon silent) and what each of them becomes. The mapping
 * from Horizon's lines to a balance is `balance-lines.spec.ts`, and that a real load
 * carries those lines at all is `stellar.service.spec.ts`.
 *
 * The live run against Testnet - where the numbers are compared with Horizon for the same
 * account - is `test/wallet.e2e-spec.ts`, opt-in and skipped here.
 */

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USER_ID = '1f0b7f2e-8f4a-4c2b-9d3e-5a6b7c8d9e0f';
const PUBLIC_KEY = 'GCEKPAYY2BODURJDT6V4YP2QPB27RQTPJMWB2T2EFXPGMHSFGX5Q7CUT';
const CREATED_AT = new Date('2026-09-29T03:00:41.512Z');

const NATIVE_LINE: StellarBalanceLine = { asset_type: 'native', balance: '9999.9999900' };
const USDC_LINE: StellarBalanceLine = {
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: ISSUER,
  balance: '0.0000000',
  limit: '922337203685.4775807',
  is_authorized: true,
};

interface Harness {
  service: BalancesService;
  findUnique: ReturnType<typeof vi.fn>;
  loadBalances: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.spyOn>;
}

/**
 * One read, with the row and the network's answer both under the test's control.
 *
 * `row: null` is the no-wallet case; `failure` is what Horizon did (the two error types
 * the account source classifies); everything else is a funded account with the lines given.
 */
function harnessWith(options: {
  row?: { id: string; publicKey: string; createdAt: Date } | null;
  lines?: readonly StellarBalanceLine[];
  failure?: Error;
}): Harness {
  const row =
    options.row === undefined
      ? { id: 'account-1', publicKey: PUBLIC_KEY, createdAt: CREATED_AT }
      : options.row;

  const findUnique = vi.fn(async () => row);
  const loadBalances = vi.fn(async () => {
    if (options.failure !== undefined) {
      throw options.failure;
    }

    return options.lines ?? [NATIVE_LINE, USDC_LINE];
  });

  const prisma = { stellarAccount: { findUnique } } as unknown as PrismaService;
  const stellar = {
    network: () => StellarNetwork.Testnet,
    loadBalances,
  } as unknown as StellarService;
  const trustline = {
    assetIdentity: () => ({ code: 'USDC', issuer: ISSUER }),
  } as unknown as UsdcTrustlineService;

  return {
    service: new BalancesService(prisma, stellar, trustline),
    findUnique,
    loadBalances,
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  };
}

describe('BalancesService', () => {
  it('reports the account as the row and the network together describe it', async () => {
    const { service } = harnessWith({});

    await expect(service.accountFor(USER_ID)).resolves.toEqual({
      accountId: 'account-1',
      publicKey: PUBLIC_KEY,
      network: StellarNetwork.Testnet,
      createdAt: '2026-09-29T03:00:41.512Z',
      funded: true,
      nativeBalance: '9999.9999900',
    });
  });

  it('reports the USDC line for the asset the app is actually configured for', async () => {
    const { service } = harnessWith({});

    await expect(service.balanceFor(USER_ID)).resolves.toEqual({
      // The issuer comes from `UsdcTrustlineService`, not from a literal here: the identity
      // has to be the one the trustline was established for, or the endpoint would report a
      // number for an asset the wallet cannot receive.
      asset: { code: 'USDC', issuer: ISSUER },
      balance: '0.0000000',
      trustline: 'active',
      funded: true,
    });
  });

  it('reads the row by user id, and does not load the sealed key', async () => {
    const { service, findUnique } = harnessWith({});

    await service.balanceFor(USER_ID);

    // Three columns: the key to ask Horizon about, the id to name the wallet, and when it
    // was created. `encrypted_secret_key` and `data_key_arn` are not selected on purpose -
    // a balance endpoint has no reason to pull ciphertext into memory, and this is the
    // assertion that keeps that true when the response grows.
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { userId: USER_ID },
      select: { id: true, publicKey: true, createdAt: true },
    });
  });

  it('answers 404 when the user has no wallet yet, rather than an empty one', async () => {
    const { service, loadBalances } = harnessWith({ row: null });

    await expect(service.balanceFor(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.accountFor(USER_ID)).rejects.toThrow(/No Stellar account/);

    // Nothing was asked of the network: there is no public key to ask about.
    expect(loadBalances).not.toHaveBeenCalled();
  });

  it('answers 200 with nothing in it for a wallet the ledger has never seen', async () => {
    const { service } = harnessWith({ failure: new StellarAccountNotFoundError(PUBLIC_KEY) });

    // Not a 404 (the wallet exists - the app has the address) and not a 5xx (the state is
    // retryable, and the next provisioning attempt is what fixes it). `null` rather than
    // `0.0000000`, because an account that does not exist does not have a zero balance.
    await expect(service.balanceFor(USER_ID)).resolves.toEqual({
      asset: { code: 'USDC', issuer: ISSUER },
      balance: null,
      trustline: 'missing',
      funded: false,
    });

    await expect(service.accountFor(USER_ID)).resolves.toMatchObject({
      publicKey: PUBLIC_KEY,
      funded: false,
      nativeBalance: null,
    });
  });

  it('answers 503 - "unknown, not zero" - when Horizon did not answer at all', async () => {
    const { service, warn } = harnessWith({ failure: new StellarAccountSourceError(PUBLIC_KEY) });

    const failure = (await service
      .balanceFor(USER_ID)
      .catch((error: unknown) => error)) as ServiceUnavailableException;

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    // The message is the whole point of the status: a client that showed a balance here
    // would be showing a number the server does not have.
    expect(failure.message).toMatch(/unknown rather than zero/);

    // And an operator can find which account it was: the public key is public, and it is
    // the only thing that distinguishes one unreachable account from another.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PUBLIC_KEY));

    warn.mockRestore();
  });

  it('lets an unclassified failure through instead of turning it into a balance', async () => {
    const bug = new Error('something nobody classified');
    const { service } = harnessWith({ failure: bug });

    // A bug belongs to the global filter and Sentry, not to this endpoint's range of
    // answers - and a balance endpoint that swallowed one would be hiding a 500 behind a
    // 200.
    await expect(service.accountFor(USER_ID)).rejects.toBe(bug);
  });

  it('reads Horizon on every call, whether or not the previous one answered', async () => {
    const { service, loadBalances } = harnessWith({});

    await service.accountFor(USER_ID);
    await service.balanceFor(USER_ID);

    // Two calls, two loads: nothing is memoised. A cache would make Step 20's audit - this
    // response against a fresh Horizon query - prove only that the cache was warm.
    expect(loadBalances).toHaveBeenCalledTimes(2);
    expect(loadBalances).toHaveBeenCalledWith(PUBLIC_KEY);
  });
});
