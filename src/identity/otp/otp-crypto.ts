import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Handling of the OTP secret itself (Step 12): generate it, hash it, compare
 * against a hash. Isolated in its own module because these are the three
 * operations it is easy to get subtly wrong, and each one has a test that fails
 * loudly if it regresses.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt rather than SHA-256: a 6-digit code has only a million possible values,
 * so a fast hash is a list of a million hashes away from being reversed. These
 * parameters are the Node defaults for a reason - `N=16384, r=8` costs ~16MB and
 * a few milliseconds per guess, which is nothing for one verification request and
 * a lot for a million of them.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH_BYTES = 32;
const SALT_BYTES = 16;

/** Marks the format, so a future change cannot be mistaken for a corrupt row. */
const HASH_SCHEME = 'scrypt';
const HASH_FIELDS = 6;

/**
 * Generates a numeric code of `length` digits.
 *
 * `randomInt` (CSPRNG) rather than `Math.random`, which is seeded predictably
 * enough that guessing the next code would be an attack on the generator instead
 * of on the 6 digits.
 *
 * The padding is load-bearing: a code of `012345` has to arrive as six digits, or
 * a user typing what the SMS says is told their code is wrong.
 */
export function generateOtpCode(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}

/**
 * Hashes a code for storage.
 *
 * Each call uses a fresh random salt, so two users issued the same code have
 * different rows and the database never reveals that two codes match - and a
 * rainbow table of a million 6-digit codes is useless against it.
 *
 * The result is self-describing (`scrypt$N$r$p$salt$hash`), so the parameters in
 * force at issue time travel with the hash: raising them later does not
 * invalidate codes that are still in flight.
 */
export async function hashOtpCode(code: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(code, salt, KEY_LENGTH_BYTES, { ...SCRYPT_PARAMS });

  return [
    HASH_SCHEME,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/**
 * Compares a submitted code against a stored hash, in constant time.
 *
 * `timingSafeEqual` rather than `===` on the derived bytes: a byte-by-byte
 * comparison leaks how much of the hash matched through its timing, and the hash
 * is only a million guesses away.
 *
 * A stored value that is not in the expected format returns `false` rather than
 * throwing. A row we cannot parse cannot prove anything, so it proves nothing -
 * and a corrupt row must not turn into a 500 on a verification endpoint, where
 * the caller's next move is the same either way (ask for a new code).
 */
export async function verifyOtpCode(code: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');

  if (parts.length !== HASH_FIELDS || parts[0] !== HASH_SCHEME) {
    return false;
  }

  const [, rawN, rawR, rawP, saltHex, hashHex] = parts;
  const params = {
    N: Number(rawN),
    r: Number(rawR),
    p: Number(rawP),
  };

  // Guarded because these four fields come off a database column: `Number('x')`
  // is `NaN`, and scrypt throws on it - which would be a 500 rather than a
  // refusal. `N` is also bounded so a nonsense value cannot make a request spend
  // all its time in key derivation.
  if (
    !Number.isInteger(params.N) ||
    !Number.isInteger(params.r) ||
    !Number.isInteger(params.p) ||
    params.N < 2 ||
    params.N > 1_048_576 ||
    params.r < 1 ||
    params.p < 1
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex ?? '', 'hex');
  const expected = Buffer.from(hashHex ?? '', 'hex');

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = await scryptAsync(code, salt, expected.length, params);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
