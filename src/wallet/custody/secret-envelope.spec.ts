import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  SecretEnvelopeError,
  openEnvelope,
  parseEnvelope,
  sealEnvelope,
} from './secret-envelope.js';

/**
 * The envelope is the only thing between a database dump and every user's Stellar keys,
 * so the cases here are the ways it gets attacked rather than the happy path alone: a blob
 * moved to another account's row, a byte flipped in the ciphertext, the tag swapped, the
 * version relabelled, a segment dropped, a segment that is not base64url at all.
 *
 * Each failure asserts the *reason* as well as the error type, because the reason is what
 * tells an operator whether they are looking at corruption, at a rotation mistake, or at
 * an attacker.
 */

const ACCOUNT = 'f0b1f3ba-6a9b-4a1b-9f4c-6dcb1e2a1234';
const OTHER_ACCOUNT = '1c0f2a44-8f5e-4b64-a6c1-4b6e1a8f9d21';
const DATA_KEY = Buffer.alloc(32, 7);
const OTHER_DATA_KEY = Buffer.alloc(32, 11);
/** Opaque to this module: only its length floor is checked, never its contents. */
const WRAPPED_DATA_KEY = Buffer.alloc(116, 9);
/** A real seed, so the round trip is proved against the SDK rather than a stand-in. */
const SEED = Keypair.random().secret();

interface SealOptions {
  accountId?: string;
  dataKey?: Buffer;
  wrappedDataKey?: Buffer;
  seed?: string;
}

function seal(options: SealOptions = {}): string {
  return sealEnvelope({
    accountId: options.accountId ?? ACCOUNT,
    secretSeed: options.seed ?? SEED,
    dataKey: options.dataKey ?? DATA_KEY,
    wrappedDataKey: options.wrappedDataKey ?? WRAPPED_DATA_KEY,
  });
}

function open(envelope: string, options: { accountId?: string; dataKey?: Buffer } = {}): string {
  const accountId = options.accountId ?? ACCOUNT;

  return openEnvelope({
    accountId,
    parts: parseEnvelope(envelope, accountId),
    dataKey: options.dataKey ?? DATA_KEY,
  });
}

/** Runs `run` and returns the error it threw; fails the test if it did not throw. */
function failure(run: () => unknown): SecretEnvelopeError {
  try {
    run();
  } catch (caught) {
    return caught as SecretEnvelopeError;
  }

  throw new Error('expected the callback to throw, but it did not');
}

/** Rebuilds an envelope with one segment replaced, keeping it otherwise valid. */
function withSegment(envelope: string, index: number, value: string): string {
  const segments = envelope.split('.');
  segments[index] = value;

  return segments.join('.');
}

describe('the stored form', () => {
  it('round trips a real Stellar seed', () => {
    const keypair = Keypair.random();
    const envelope = seal({ seed: keypair.secret() });

    const opened = open(envelope);

    expect(opened).toBe(keypair.secret());
    // Not just equal strings: the recovered seed has to be the same *account*.
    expect(Keypair.fromSecret(opened).publicKey()).toBe(keypair.publicKey());
  });

  it('is five base64url segments, the first of which is the version', () => {
    const segments = seal().split('.');

    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe(ENVELOPE_VERSION);
    // base64url, so the whole thing survives a URL, a JSON body, a log line and a SQL
    // literal unescaped - which is the reason for the alphabet, not an accident of it.
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never contains the seed', () => {
    const keypair = Keypair.random();
    const envelope = seal({ seed: keypair.secret() });

    expect(envelope).not.toContain(keypair.secret());
    // The seed is 56 characters; a base64 of it would be 76. Neither may appear.
    expect(envelope).not.toContain(Buffer.from(keypair.secret(), 'utf8').toString('base64url'));
  });

  it('produces different bytes on every seal, even for one account and one data key', () => {
    const keypair = Keypair.random();
    const first = seal({ seed: keypair.secret() });
    const second = seal({ seed: keypair.secret() });

    expect(first).not.toBe(second);

    // The wrapped data key is the same, so the difference is the IV - which is the point:
    // a random IV per call means sealing the same seed twice never repeats a keystream.
    expect(first.split('.')[1]).toBe(second.split('.')[1]);
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
  });
});

describe('the two bindings', () => {
  it('refuses to open an account\'s envelope under another account', () => {
    const envelope = seal({ accountId: ACCOUNT });

    // This is the attack worth caring about: someone with write access to the table moves
    // one blob onto another account's row. The AAD check fails locally, so it fails
    // without a KMS call - and the plaintext is never produced.
    const failed = failure(() => open(envelope, { accountId: OTHER_ACCOUNT }));

    expect(failed).toBeInstanceOf(SecretEnvelopeError);
    expect(failed.reason).toBe('authentication-failed');
    expect(failed.accountId).toBe(OTHER_ACCOUNT);
  });

  it('refuses a data key that is not the one the seed was sealed with', () => {
    const envelope = seal({ dataKey: DATA_KEY });

    const failed = failure(() => open(envelope, { dataKey: OTHER_DATA_KEY }));

    expect(failed.reason).toBe('authentication-failed');
  });
});

describe('tampering', () => {
  it('refuses a flipped byte anywhere in the ciphertext', () => {
    const envelope = seal();
    const ciphertext = Buffer.from(envelope.split('.')[4] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x01;

    const failed = failure(() => open(withSegment(envelope, 4, ciphertext.toString('base64url'))));

    expect(failed.reason).toBe('authentication-failed');
  });

  it('refuses a swapped authentication tag', () => {
    const first = seal();
    const second = seal();

    // Same key, same account, different tag: the tag is not interchangeable.
    const failed = failure(() => open(withSegment(first, 3, second.split('.')[3] ?? '')));

    expect(failed.reason).toBe('authentication-failed');
  });

  it('refuses a relabelled version, before any key is consulted', () => {
    const envelope = seal();
    const relabelled = envelope.replace(ENVELOPE_VERSION, 'cp-kms-2');

    const failed = failure(() => parseEnvelope(relabelled, ACCOUNT));

    // The version is checked first, so a blob from a format this code does not know is
    // never handed to a cipher at all.
    expect(failed.reason).toBe('unknown-version');
  });

  it('refuses a dropped segment', () => {
    const segments = seal().split('.');
    const truncated = segments.slice(0, 4).join('.');

    expect(failure(() => parseEnvelope(truncated, ACCOUNT)).reason).toBe('malformed');
  });

  it('refuses a segment that is not base64url', () => {
    // '+' is valid base64 and invalid base64url, and Node's decoder would silently accept
    // it - hence the pattern check before decoding.
    const envelope = withSegment(seal(), 2, '+not-base64url+');

    expect(failure(() => parseEnvelope(envelope, ACCOUNT)).reason).toBe('malformed');
  });

  it('refuses a ciphertext that is not a 56-byte seed', () => {
    const short = withSegment(seal(), 4, Buffer.alloc(10, 1).toString('base64url'));

    expect(failure(() => parseEnvelope(short, ACCOUNT)).reason).toBe('wrong-length');
  });

  it('refuses an IV or tag of the wrong size', () => {
    expect(
      failure(() => parseEnvelope(withSegment(seal(), 2, Buffer.alloc(8, 1).toString('base64url')), ACCOUNT))
        .reason,
    ).toBe('wrong-length');

    expect(
      failure(() =>
        parseEnvelope(withSegment(seal(), 3, Buffer.alloc(8, 1).toString('base64url')), ACCOUNT),
      ).reason,
    ).toBe('wrong-length');
  });

  it('refuses a wrapped data key that has been truncated', () => {
    const envelope = withSegment(seal(), 1, Buffer.alloc(16, 1).toString('base64url'));

    expect(failure(() => parseEnvelope(envelope, ACCOUNT)).reason).toBe('wrong-length');
  });
});

describe('what it refuses to seal', () => {
  it('refuses a data key that is not 32 bytes', () => {
    // Not a `wrong-length` *envelope* failure: a data key of the wrong size is not a
    // property of the stored blob, it is a bug (or a KMS answer that is not the key that
    // was asked for), and it must not be reported as if the blob were damaged.
    expect(failure(() => seal({ dataKey: Buffer.alloc(16, 1) })).reason).toBe('malformed');
    expect(failure(() => open(seal(), { dataKey: Buffer.alloc(16, 1) })).reason).toBe('malformed');
  });

  it('refuses anything that is not a Stellar secret seed', () => {
    for (const candidate of ['', 'not-a-seed', 'S', `S${'a'.repeat(54)}`, `G${'a'.repeat(55)}`]) {
      expect(failure(() => seal({ seed: candidate })).reason).toBe('not-a-seed');
    }
  });
});
