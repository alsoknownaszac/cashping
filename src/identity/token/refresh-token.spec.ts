import { describe, expect, it } from 'vitest';
import {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_LENGTH,
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
} from './refresh-token.js';

/**
 * These are the three functions a session depends on and that nothing else in the
 * suite exercises directly: the service tests would still pass if the token were
 * predictable or the hash were truncating, because the service hashes and looks up
 * with the same helpers. So the properties are asserted here instead - length,
 * alphabet, unpredictability, and a known-answer digest.
 */

describe('generateRefreshToken', () => {
  it('returns a URL-safe token of exactly the length the shape check expects', () => {
    const token = generateRefreshToken();

    expect(token).toHaveLength(REFRESH_TOKEN_LENGTH);
    expect(looksLikeRefreshToken(token)).toBe(true);
    // 32 bytes, unpadded base64url: base64url is the only alphabet that produces
    // exactly this length for this input, so the assertion also pins the encoding.
    expect(REFRESH_TOKEN_LENGTH).toBe(Math.ceil((REFRESH_TOKEN_BYTES * 4) / 3));
  });

  it('contains no character that a query string or a shell would mangle', () => {
    // The base64 characters that base64url replaces, plus the padding it drops.
    expect(generateRefreshToken()).not.toMatch(/[+/=]/);
  });

  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateRefreshToken()));

    expect(tokens.size).toBe(1000);
  });

  it('does not start from a seed that can be replayed', () => {
    // A weak implementation (a counter, a timestamp, a UUID v1) tends to differ only
    // in its tail; this checks that two tokens generated microseconds apart differ
    // from their first characters, not just their last.
    const first = generateRefreshToken();
    const second = generateRefreshToken();

    expect(first.slice(0, 16)).not.toBe(second.slice(0, 16));
  });
});

describe('hashRefreshToken', () => {
  it('is a hex-encoded SHA-256, and the known answer for a known input', () => {
    // The published SHA-256 of 'abc'. Pinning it catches a swap to another digest
    // (SHA-1, MD5, a truncation) that every other assertion here would accept,
    // because they only ever compare our own output with our own output.
    expect(hashRefreshToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashRefreshToken(generateRefreshToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, because the digest is how a token is looked up', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('separates two tokens that differ by a single character', () => {
    const token = generateRefreshToken();
    const tweaked = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect(hashRefreshToken(token)).not.toBe(hashRefreshToken(tweaked));
  });

  it('never returns the token itself', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).not.toContain(token);
  });
});

describe('looksLikeRefreshToken', () => {
  it.each([
    ['an empty string', ''],
    ['a short string', 'abc'],
    ['an access token pasted into the wrong field', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x'],
    ['a padded base64 value', `${'a'.repeat(43)}=`],
    ['standard base64, with + and /', `${'a'.repeat(20)}+/${'b'.repeat(20)}`],
    ['a 42-character token, one short', 'a'.repeat(42)],
    ['a 44-character token, one long', 'a'.repeat(44)],
    ['whitespace around a real token', ` ${generateRefreshToken()} `],
  ])('rejects %s', (_label, value) => {
    expect(looksLikeRefreshToken(value)).toBe(false);
  });

  it('accepts both cases of the base64url alphabet and its two symbols', () => {
    expect(looksLikeRefreshToken('A'.repeat(43))).toBe(true);
    expect(looksLikeRefreshToken('zZ09_-'.padEnd(43, 'a'))).toBe(true);
  });
});
