import type { ConfigService } from '@nestjs/config';
import { Keypair, NotFoundError, type TransactionSource } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { StellarAccountNotFoundError, StellarAccountSourceError } from './account-source.js';
import {
  HorizonAccountSource,
  type HorizonServer,
  type HorizonServerFactory,
} from './horizon-account-source.js';

/**
 * The only thing this class *does* is translate Horizon's failures, and the two
 * translations call for opposite reactions:
 *
 * - a 404 is "this keypair has never been funded", a normal state for a freshly
 *   generated account, and Step 19 has to create it rather than report an outage;
 * - anything else is "Horizon did not answer", where the account's state is
 *   unknown and the only correct move is to try again later.
 *
 * A fake Horizon is used throughout - the real one is a public network, and what is
 * being tested is the mapping, not the SDK.
 */

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const ACCOUNT = Keypair.random().publicKey();

function configWith(horizonUrl = HORIZON_URL): ConfigService {
  return {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'stellar.horizonUrl') {
        return horizonUrl;
      }

      throw new Error(`unexpected config key ${key}`);
    }),
  } as unknown as ConfigService;
}

/** A `Horizon.Server` with only the one method this source calls. */
function horizonReturning(loadAccount: (accountId: string) => Promise<TransactionSource>): {
  server: HorizonServer;
  loadAccount: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(loadAccount);

  return { server: { loadAccount: spy } as unknown as HorizonServer, loadAccount: spy };
}

function sourceWith(
  loadAccount: (accountId: string) => Promise<TransactionSource>,
  horizonUrl = HORIZON_URL,
): {
  source: HorizonAccountSource;
  factory: ReturnType<typeof vi.fn>;
  loadAccount: ReturnType<typeof vi.fn>;
} {
  const { server, loadAccount: spy } = horizonReturning(loadAccount);
  const factory = vi.fn<HorizonServerFactory>(() => server);

  return {
    source: new HorizonAccountSource(configWith(horizonUrl), factory),
    factory,
    loadAccount: spy,
  };
}

/** The account as Horizon reports it: id plus current sequence number. */
const loadedAccount = {
  accountId: () => ACCOUNT,
  sequenceNumber: () => '100',
  incrementSequenceNumber: () => undefined,
} as TransactionSource;

describe('HorizonAccountSource', () => {
  it('asks Horizon for the requested account and returns what it answered', async () => {
    const { source, loadAccount } = sourceWith(async () => loadedAccount);

    await expect(source.loadAccount(ACCOUNT)).resolves.toBe(loadedAccount);
    expect(loadAccount).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
  });

  it('never serves a cached account: every load asks Horizon again', async () => {
    const { source, loadAccount } = sourceWith(async () => loadedAccount);

    await source.loadAccount(ACCOUNT);
    await source.loadAccount(ACCOUNT);

    // A cached sequence number is exactly the stale snapshot the whole step is
    // about, so caching here would quietly reintroduce the race.
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });

  it('builds its client from the configured Horizon url, and only once', async () => {
    const { source, factory } = sourceWith(async () => loadedAccount, 'https://horizon.example');

    await source.loadAccount(ACCOUNT);
    await source.loadAccount(ACCOUNT);

    expect(factory).toHaveBeenCalledExactlyOnceWith('https://horizon.example');
  });

  it('maps a missing account to the not-found error, keeping the cause', async () => {
    const missing = new NotFoundError('Resource Missing', { status: 404 });
    const { source } = sourceWith(() => Promise.reject(missing));

    const failure = (await source.loadAccount(ACCOUNT).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(StellarAccountNotFoundError);
    expect((failure as StellarAccountNotFoundError).accountId).toBe(ACCOUNT);
    expect(failure.cause).toBe(missing);
    expect(failure.message).toContain(ACCOUNT);
  });

  it('maps every other failure to the source error, never to not-found', async () => {
    const outage = new Error('socket hang up');
    const { source } = sourceWith(() => Promise.reject(outage));

    const failure = (await source.loadAccount(ACCOUNT).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(StellarAccountSourceError);
    expect(failure).not.toBeInstanceOf(StellarAccountNotFoundError);
    expect(failure.cause).toBe(outage);
  });

  it('wraps a client the SDK refuses, rather than leaking a raw SDK error', async () => {
    // This is what a plain-http Horizon off loopback looks like: it fails when the
    // client is built, not when it is called.
    const refused = new Error('Cannot connect to insecure horizon server');
    const source = new HorizonAccountSource(configWith('http://horizon.example'), () => {
      throw refused;
    });

    const failure = (await source.loadAccount(ACCOUNT).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(StellarAccountSourceError);
    expect(failure.cause).toBe(refused);
  });
});
