import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { StellarNetwork } from '../../config/validation.schema.js';
import {
  NETWORK_PASSPHRASES,
  horizonServerOptions,
  networkPassphraseFor,
  parseStellarNetwork,
} from './stellar-network.js';

/**
 * The passphrase is what a signature is bound to, so getting the network wrong is
 * not a misconfiguration you notice later - it produces transactions that are
 * valid on the *other* network, and a testnet-only bug that signs for mainnet is
 * the most expensive kind this codebase can have. Hence: the mapping is explicit,
 * every member of the enum is covered, and an unknown value is refused rather than
 * defaulted.
 */
describe('parseStellarNetwork', () => {
  it('accepts the two networks the environment schema allows', () => {
    expect(parseStellarNetwork('TESTNET')).toBe(StellarNetwork.Testnet);
    expect(parseStellarNetwork('PUBLIC')).toBe(StellarNetwork.Public);
  });

  it('refuses anything else, naming the value it refused', () => {
    expect(() => parseStellarNetwork('MAINNET')).toThrowError(/MAINNET/);
    expect(() => parseStellarNetwork('')).toThrowError(/Unknown STELLAR_NETWORK/);
    expect(() => parseStellarNetwork('testnet')).toThrowError(/Unknown STELLAR_NETWORK/);
  });

  it('does not quietly treat an unset value as testnet', () => {
    // "undefined" here stands for any value that reached the config layer
    // unvalidated; refusing is the only safe answer, because the fallback would
    // otherwise be chosen by whichever network the default happened to be.
    expect(() => parseStellarNetwork('undefined')).toThrowError(/Unknown STELLAR_NETWORK/);
  });
});

describe('networkPassphraseFor', () => {
  it('maps TESTNET to the testnet passphrase the SDK signs with', () => {
    expect(networkPassphraseFor(StellarNetwork.Testnet)).toBe(Networks.TESTNET);
  });

  it('maps PUBLIC to the pubnet passphrase the SDK signs with', () => {
    expect(networkPassphraseFor(StellarNetwork.Public)).toBe(Networks.PUBLIC);
  });

  it('covers every member of the network enum', () => {
    // A new `StellarNetwork` member without a passphrase is the failure this
    // catches: `Record<StellarNetwork, string>` already fails the build, and this
    // fails the test, so neither can be merged in a hurry.
    expect(Object.keys(NETWORK_PASSPHRASES).sort()).toEqual(Object.values(StellarNetwork).sort());
  });

  it('never maps two networks onto one passphrase', () => {
    expect(Networks.TESTNET).not.toBe(Networks.PUBLIC);
    expect(new Set(Object.values(NETWORK_PASSPHRASES)).size).toBe(
      Object.keys(NETWORK_PASSPHRASES).length,
    );
  });
});

describe('horizonServerOptions', () => {
  it('permits plain http for the loopback hosts a local node answers on', () => {
    expect(horizonServerOptions('http://localhost:8000').allowHttp).toBe(true);
    expect(horizonServerOptions('http://127.0.0.1:8000').allowHttp).toBe(true);
    expect(horizonServerOptions('http://[::1]:8000').allowHttp).toBe(true);
  });

  it('refuses plain http anywhere else, and never needs it over https', () => {
    expect(horizonServerOptions('http://horizon-testnet.stellar.org').allowHttp).toBe(false);
    expect(horizonServerOptions('http://horizon.stellar.org').allowHttp).toBe(false);
    expect(horizonServerOptions('https://horizon-testnet.stellar.org').allowHttp).toBe(false);
  });

  it('refuses plain http for a host it cannot parse', () => {
    expect(horizonServerOptions('not-a-url').allowHttp).toBe(false);
    expect(horizonServerOptions('horizon-testnet.stellar.org').allowHttp).toBe(false);
  });

  it('does not mistake a lookalike hostname for loopback', () => {
    // `localhost.example.com` is a DNS name someone else can own.
    expect(horizonServerOptions('http://localhost.example.com').allowHttp).toBe(false);
    expect(horizonServerOptions('http://127.0.0.1.example.com').allowHttp).toBe(false);
  });
});
