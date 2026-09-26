import { beforeAll, describe, expect, it } from 'vitest';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from './otp-crypto.js';

/**
 * The three operations the whole OTP flow's security rests on, asserted directly
 * rather than through a service (Step 12): this file is what fails if the
 * generator stops padding, the hash stops salting, or the comparison stops
 * refusing a stored value it cannot parse.
 *
 * Hashing is deliberately expensive (scrypt, ~16MB per derivation), so the happy
 * paths share one hash computed in `beforeAll` instead of re-deriving per test.
 */

describe('generateOtpCode', () => {
  it('always returns exactly the requested number of digits, leading zeros included', () => {
    // 300 draws: a code starting with `0` comes up ~30 times, so the padding is
    // genuinely exercised rather than passing by luck. Without it a user typing
    // the five digits the SMS showed them would be told their code is wrong.
    for (let i = 0; i < 300; i += 1) {
      expect(generateOtpCode(6)).toMatch(/^\d{6}$/);
    }
  });

  it('honours other lengths, so the policy can change without touching this module', () => {
    expect(generateOtpCode(4)).toMatch(/^\d{4}$/);
    expect(generateOtpCode(8)).toMatch(/^\d{8}$/);
  });

  it('draws from a real random source rather than returning a constant', () => {
    const codes = new Set(Array.from({ length: 300 }, () => generateOtpCode(6)));

    // Not "300 distinct": 300 draws from a million values collide a few percent
    // of the time, which would make that assertion flaky. A generator stuck on
    // one value, or on a short cycle, collapses to a handful instead.
    expect(codes.size).toBeGreaterThan(250);
  });
});

describe('hashOtpCode / verifyOtpCode', () => {
  const CODE = '123456';
  let stored: string;

  beforeAll(async () => {
    stored = await hashOtpCode(CODE);
  });

  it('stores a self-describing hash that does not contain the code', () => {
    // The format carries its cost parameters, so raising them later does not
    // invalidate codes that are already in flight.
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain(CODE);
  });

  it('accepts the code it was made from', async () => {
    await expect(verifyOtpCode(CODE, stored)).resolves.toBe(true);
  });

  it('rejects a code that differs by a single digit', async () => {
    await expect(verifyOtpCode('123457', stored)).resolves.toBe(false);
    await expect(verifyOtpCode('12345', stored)).resolves.toBe(false);
    await expect(verifyOtpCode('0123456', stored)).resolves.toBe(false);
  });

  it('salts every hash, so two rows holding the same code are not identical', async () => {
    const [other, third] = await Promise.all([hashOtpCode(CODE), hashOtpCode(CODE)]);

    // Without a salt these would be the same string, and one lookup would reveal
    // every user issued that code.
    expect(other).not.toBe(stored);
    expect(third).not.toBe(other);
    // Both still verify: the salt is stored with the hash, not derived from it.
    await expect(verifyOtpCode(CODE, other)).resolves.toBe(true);
    await expect(verifyOtpCode(CODE, third)).resolves.toBe(true);
  });

  it('rejects a hash of the right shape but the wrong derivation length', async () => {
    const [scheme, n, r, p, salt] = stored.split('$');

    await expect(verifyOtpCode(CODE, `${scheme}$${n}$${r}$${p}$${salt}$aabb`)).resolves.toBe(false);
  });

  /**
   * A stored value that cannot be parsed proves nothing, so it must return
   * `false` rather than throw: a corrupt row turning into a 500 would tell an
   * attacker which rows are damaged, and the caller's next move is the same
   * either way (ask for a new code).
   */
  const MALFORMED_HASHES: ReadonlyArray<readonly [string, string]> = [
    ['an empty column', ''],
    ['the plaintext code', CODE],
    ['an unknown scheme', 'sha256$16384$8$1$aabb$aabb'],
    ['a missing field', 'scrypt$16384$8$1$aabb'],
    ['a non-numeric cost', 'scrypt$not-a-number$8$1$aabb$aabb'],
    ['a cost above the guard', 'scrypt$99999999$8$1$aabb$aabb'],
    ['a cost below the guard', 'scrypt$0$8$1$aabb$aabb'],
    ['an empty salt', 'scrypt$16384$8$1$$aabb'],
    ['an empty hash', 'scrypt$16384$8$1$aabb$'],
    ['a non-hex salt and hash', 'scrypt$16384$8$1$zz$zz'],
  ];

  for (const [description, malformed] of MALFORMED_HASHES) {
    it(`refuses ${description} instead of throwing`, async () => {
      await expect(verifyOtpCode(CODE, malformed)).resolves.toBe(false);
    });
  }
});
