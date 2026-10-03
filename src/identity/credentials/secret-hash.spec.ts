import { beforeAll, describe, expect, it } from 'vitest';
import { hashSecret, verifySecret } from './secret-hash.js';

/**
 * The pair every credential in this API rests on (Step 34a, lifted from
 * `otp-crypto.spec.ts` when the PIN became the second caller): a secret hashes to a
 * self-describing string, the secret it was made from verifies, and a stored value this
 * module cannot parse is refused rather than thrown at a caller.
 *
 * It is asserted directly rather than through a service because three services now share
 * it - `OtpService`, `PinService` and `PasswordService` - so a regression here would
 * otherwise have to be caught three times.
 *
 * Hashing is deliberately expensive (scrypt, ~16MB per derivation), so the happy paths
 * share one hash computed in `beforeAll` instead of re-deriving per test.
 */

/** A 4-digit PIN, which is the shortest secret any caller passes here. */
const SECRET = '1234';

describe('hashSecret / verifySecret', () => {
  let stored: string;

  beforeAll(async () => {
    stored = await hashSecret(SECRET);
  });

  it('stores a self-describing hash that does not contain the secret', () => {
    // The format carries its cost parameters, so raising them later does not invalidate
    // hashes that are already stored - and the plaintext must not be recoverable by
    // reading the column, which is the whole reason a PIN is not stored as four digits.
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain(SECRET);
  });

  it('accepts the secret it was made from', async () => {
    await expect(verifySecret(SECRET, stored)).resolves.toBe(true);
  });

  it('rejects a secret that differs by a single character', async () => {
    await expect(verifySecret('1235', stored)).resolves.toBe(false);
    await expect(verifySecret('123', stored)).resolves.toBe(false);
    await expect(verifySecret('01234', stored)).resolves.toBe(false);
    await expect(verifySecret('', stored)).resolves.toBe(false);
  });

  it('salts every hash, so two rows holding the same secret are not identical', async () => {
    const [other, third] = await Promise.all([hashSecret(SECRET), hashSecret(SECRET)]);

    // Without a salt these would be the same string, and one lookup would reveal every
    // account whose owner chose the PIN the attacker is trying.
    expect(other).not.toBe(stored);
    expect(third).not.toBe(other);
    // Both still verify: the salt is stored with the hash, not derived from it.
    await expect(verifySecret(SECRET, other)).resolves.toBe(true);
    await expect(verifySecret(SECRET, third)).resolves.toBe(true);
  });

  it('rejects a hash of the right shape but the wrong derivation length', async () => {
    const [scheme, n, r, p, salt] = stored.split('$');

    await expect(verifySecret(SECRET, `${scheme}$${n}$${r}$${p}$${salt}$aabb`)).resolves.toBe(
      false,
    );
  });

  /**
   * A stored value that cannot be parsed proves nothing, so it must return `false`
   * rather than throw: a corrupt row turning into a 500 would tell an attacker which rows
   * are damaged, and it would also mean a broken row locks an account out of every
   * endpoint that verifies against it.
   */
  const MALFORMED_HASHES: ReadonlyArray<readonly [string, string]> = [
    ['an empty column', ''],
    ['the plaintext secret', SECRET],
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
      await expect(verifySecret(SECRET, malformed)).resolves.toBe(false);
    });
  }
});
