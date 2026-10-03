import { describe, expect, it } from 'vitest';
import { generateOtpCode } from './otp-crypto.js';

/**
 * The generator (Step 12), asserted directly rather than through a service: this file is
 * what fails if a code stops being zero-padded, or starts coming from a source that
 * repeats itself.
 *
 * The hashing pair that used to be tested here moved to
 * `src/identity/credentials/secret-hash.spec.ts` in Step 34a, when the transaction PIN
 * became its second caller.
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
