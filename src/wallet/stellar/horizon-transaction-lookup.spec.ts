import { type ConfigService } from '@nestjs/config';
import { NotFoundError, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { type HorizonServer } from './horizon-account-source.js';
import { HorizonTransactionLookup, transactionCodeOf } from './horizon-transaction-lookup.js';

/**
 * The mapping from Horizon's HTTP into the port's three answers, and the reason that mapping is its
 * own file: `NotFoundError` is a *normal* answer (a hash Horizon has not ingested, or never will)
 * while every other failure means "we could not ask", and a caller that confused the two - or a
 * poller that read a 503 as a verdict - would fail payments that landed.
 *
 * The record shape asserted here is the one Horizon really returns, verified against a real failed
 * Testnet transaction: `successful: false`, `result_xdr`, and *no* `result_codes` (that field exists
 * on a submission's HTTP 400 body, not on a fetched record), which is why the transaction-level code
 * is decoded from the XDR instead.
 *
 * `Horizon.Server` is faked at the factory, exactly as `HorizonAccountSource`'s spec does it: the
 * class builds its own client lazily, and what is worth pinning is the mapping - which is pure -
 * rather than the SDK's HTTP plumbing.
 */

/** The fields of a fetched record this class reads. */
interface FakeRecord {
  readonly ledger_attr: number;
  readonly successful: boolean;
  readonly result_xdr: string;
}

/** A record as Horizon returns one, with the transaction-level outcome given. */
function record(result: xdr.TransactionResultResult, successful: boolean): FakeRecord {
  return {
    ledger_attr: 4321,
    successful,
    result_xdr: new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result,
      ext: xdr.TransactionResultExt.v0(),
    }).toXDR('base64'),
  };
}

/** A Horizon failure that carries an HTTP status, as the SDK's own errors do. */
function horizonError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`);

  (error as { response?: unknown }).response = { status };

  return error;
}

/**
 * The class over a fake Horizon: the record to answer with (or the failure to throw), the hosts the
 * factory was asked for, and the hashes that were looked up.
 */
function lookupOver(answer: FakeRecord | Error) {
  const hosts: string[] = [];
  const hashes: string[] = [];

  const server = {
    transactions: () => ({
      transaction: (hash: string) => {
        hashes.push(hash);

        return {
          call: async (): Promise<FakeRecord> => {
            if (answer instanceof Error) {
              throw answer;
            }

            return answer;
          },
        };
      },
    }),
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

  return { lookup: new HorizonTransactionLookup(config, createServer), hosts, hashes };
}

describe('transactionCodeOf', () => {
  it("turns the SDK's variant name into Horizon's own code", () => {
    const failed = record(xdr.TransactionResultResult.txFailed([]), false).result_xdr;
    const successful = record(xdr.TransactionResultResult.txSuccess([]), true).result_xdr;

    expect(transactionCodeOf(failed)).toBe('tx_failed');
    expect(transactionCodeOf(successful)).toBe('tx_success');
  });

  it('answers null for a result it cannot read, rather than throwing', () => {
    // `null` deliberately: this is commentary on a fact (`successful`) that has already been
    // established, so a shape a future SDK spells differently must not turn a *resolution* into a
    // retry. "The ledger refused it" is still exactly what the reason says without the code.
    expect(transactionCodeOf('not-an-xdr')).toBeNull();
    expect(transactionCodeOf('')).toBeNull();
  });
});

describe('HorizonTransactionLookup', () => {
  it('reports a successful transaction as settled, with the ledger and the code', async () => {
    const { lookup } = lookupOver(record(xdr.TransactionResultResult.txSuccess([]), true));

    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({
      kind: 'settled',
      ledger: 4321,
      successful: true,
      transactionCode: 'tx_success',
    });
  });

  it('reports a transaction the ledger refused as settled and unsuccessful', async () => {
    // The distinction the port exists for: this is a *verdict* - the money did not move - while the
    // 503 below is not. The reason a customer's row carries comes from this code plus the ledger.
    const { lookup } = lookupOver(record(xdr.TransactionResultResult.txFailed([]), false));

    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({
      kind: 'settled',
      ledger: 4321,
      successful: false,
      transactionCode: 'tx_failed',
    });
  });

  it('still reports settled when the result XDR cannot be read', async () => {
    const { lookup } = lookupOver({ ledger_attr: 99, successful: false, result_xdr: 'garbage' });

    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({
      kind: 'settled',
      ledger: 99,
      successful: false,
      transactionCode: null,
    });
  });

  it("reports Horizon's 404 as not-found, which is a normal answer and not an error", async () => {
    const { lookup } = lookupOver(
      new NotFoundError('Transaction not found', { status: 404, statusText: 'Not Found' }),
    );

    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({ kind: 'not-found' });
  });

  it('reports an HTTP failure as unavailable, by status rather than by body', async () => {
    const { lookup } = lookupOver(horizonError(503));

    // The detail ends up in a log line, and the SDK's own messages carry a full URL and sometimes a
    // whole response body - so a 4xx/5xx is named by its status and nothing else.
    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({
      kind: 'unavailable',
      detail: 'Horizon answered HTTP 503',
    });
  });

  it('reports a failure with no HTTP status as Horizon not answering', async () => {
    const { lookup } = lookupOver(new Error('ETIMEDOUT'));

    await expect(lookup.lookup('a'.repeat(64))).resolves.toEqual({
      kind: 'unavailable',
      detail: 'Horizon did not answer (ETIMEDOUT)',
    });
  });

  it('builds one client from the configured host, and looks up the hash it was given', async () => {
    const { lookup, hosts, hashes } = lookupOver(
      record(xdr.TransactionResultResult.txSuccess([]), true),
    );
    const hash = 'c'.repeat(64);

    await lookup.lookup(hash);
    await lookup.lookup(hash);

    // Lazily, because a process that never polls should not open a Horizon client at all; once,
    // because a server object is a URL plus a mutable HTTP client, and a client per call would be a
    // new one every tick.
    expect(hosts).toEqual(['https://horizon-testnet.stellar.org']);
    expect(hashes).toEqual([hash, hash]);
  });
});

