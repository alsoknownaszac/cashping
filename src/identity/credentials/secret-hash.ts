import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * The one hashing implementation for the short secrets this API stores: the OTP code
 * (Step 12), the transaction PIN (Step 34a) and, from Step 34b, the password.
 *
 * Lifted out of `otp-crypto.ts`, which held it while the OTP was the only secret there
 * was. The lift is the point rather than the tidying: a second copy for the PIN would be
 * a second *verifier*, and two verifiers written from the same description drift the
 * first time one of them is corrected. One format is one verifier, and the format
 * travels with the parameters, so raising a work factor later does not invalidate hashes
 * that are already stored.
 *
 * What this file offers is deliberately narrow - hash a secret, compare a secret against
 * a hash. Nothing here decides how long a secret must be, how many guesses it survives,
 * or what a wrong one means: those are the policies of the credential that owns the
 * caller (`configuration.ts`), because a code, a PIN and a password agree on none of
 * them.
 */

/**
 * scrypt's memory cost is `128 * N * r` bytes, and Node refuses a derivation that needs more
 * than `maxmem` - which defaults to 32MB, i.e. exactly the ceiling N=16384, r=8 sits under.
 *
 * The password's stronger block needs a little more than that, so the ceiling is raised here to
 * what the parameters actually require plus a small margin, rather than left at Node's default:
 * without this, a password hash throws `memory limit exceeded` and the credential cannot be
 * written at all. It is derived from the parameters - never a fixed number - so it grows with
 * them and no valid block is refused.
 */
const SCRYPT_MEMORY_MARGIN_BYTES = 1024 * 1024;

function scryptOptions(params: SecretHashParams): ScryptOptions {
  return {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r + SCRYPT_MEMORY_MARGIN_BYTES,
  };
}

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt rather than SHA-256: a 4-digit PIN has only ten thousand possible values and a
 * 6-digit code only a million, so a fast hash is a table away from being reversed. These
 * parameters are the Node defaults for a reason - `N=16384, r=8` costs ~16MB and a few
 * milliseconds per guess, which is nothing for one verification request and a lot for
 * ten thousand of them.
 *
 * The PIN reuses them, and Step 34b's password does not: a password is drawn from a
 * space where guessing is a dictionary attack rather than a sweep, so it is hashed with a
 * stronger parameter block (`PASSWORD_SCRYPT_PARAMS`) that the one caller that needs it
 * passes in. The format travels with the parameters either way, which is what lets two
 * work factors live side by side without a second verifier.
 */
const SCRYPT_PARAMS: SecretHashParams = { N: 16384, r: 8, p: 1 };

/**
 * The cost parameters a scrypt hash was written with.
 *
 * `N` is the CPU/memory cost (memory is roughly `128 * N * r` bytes), `r` the block size and
 * `p` the parallelisation. They are a type rather than inline literals because `hashSecret`
 * now takes them as an argument: the OTP and the PIN use the defaults below, the password
 * uses the stronger block, and the difference lives at the call site rather than in a
 * second copy of this file.
 */
export interface SecretHashParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * The stronger work factor a password is hashed with (Step 34b).
 *
 * Double the default's `N`, so a password costs about twice the memory and time to verify
 * as a PIN does. The reason for the gap is the *shape* of the attack, not a claim that a
 * password is more secret than a PIN: a four-digit PIN can only be swept, and no cost stops
 * ten thousand guesses being ten thousand guesses, while a password is a *dictionary*
 * attack, where doubling the per-guess cost halves the number of candidates an attacker's
 * budget reaches. Both stay well inside a request's time budget.
 */
export const PASSWORD_SCRYPT_PARAMS: SecretHashParams = { N: 32768, r: 8, p: 1 };

const KEY_LENGTH_BYTES = 32;
const SALT_BYTES = 16;

/** Marks the format, so a future change cannot be mistaken for a corrupt row. */
const HASH_SCHEME = 'scrypt';
const HASH_FIELDS = 6;

/**
 * Hashes a secret for storage.
 *
 * Each call uses a fresh random salt, so two users who chose the same PIN have different
 * rows and the database never reveals that two secrets match - and a precomputed table of
 * every 4-digit PIN is useless against it.
 *
 * The result is self-describing (`scrypt$N$r$p$salt$hash`), so the parameters in force at
 * write time travel with the hash and a verification does not need to be told them.
 *
 * `params` defaults to the OTP/PIN block. A caller that wants a stronger work factor (the
 * password, per Step 34b) passes its own, and because the parameters travel inside the
 * hash, `verifySecret` accepts either without a change.
 */
export async function hashSecret(
  secret: string,
  params: SecretHashParams = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(secret, salt, KEY_LENGTH_BYTES, scryptOptions(params));

  return [
    HASH_SCHEME,
    params.N,
    params.r,
    params.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/**
 * Compares a submitted secret against a stored hash, in constant time.
 *
 * `timingSafeEqual` rather than `===` on the derived bytes: a byte-by-byte comparison
 * leaks how much of the hash matched through its timing, and the hash of a 4-digit PIN is
 * only ten thousand guesses away.
 *
 * A stored value that is not in the expected format returns `false` rather than throwing.
 * A row we cannot parse cannot prove anything, so it proves nothing - and a corrupt row
 * must not turn into a 500 on a verification endpoint, where the caller's next move is
 * the same either way (use the recovery path, or set a new one).
 */
export async function verifySecret(secret: string, storedHash: string): Promise<boolean> {
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

  const derived = await scryptAsync(secret, salt, expected.length, scryptOptions(params));

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
