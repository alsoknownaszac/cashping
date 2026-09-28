import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The stored form of a Stellar secret seed (Step 18):
 *
 *     cp-kms-1.<wrapped data key>.<iv>.<tag>.<ciphertext>
 *
 * Five dot-separated segments, every one base64url so the whole string survives a
 * URL, a JSON body, a log line and a SQL literal without escaping.
 *
 * Two layers, which is what "envelope encryption" means here:
 *
 * 1. a per-account **data key** (AES-256) encrypts the seed;
 * 2. the master key in KMS wraps that data key.
 *
 * The point of the second layer is the first one's cheapness: a data key per account
 * means no two accounts share a key, while a single KMS master key protects all of
 * them - and the database holds nothing that can be decrypted without a KMS call.
 *
 * ## Why the account id appears twice
 *
 * `accountId` is bound into the AES-GCM additional authenticated data (as
 * `cp-kms-1:<accountId>`) and again as the KMS `EncryptionContext` on the wrapped
 * data key. Neither is stored, because both are recomputable from the row - and
 * between them, moving a blob to another account's row fails twice: KMS refuses the
 * wrapped key (context mismatch) and the ciphertext is refused locally (AAD
 * mismatch). The version prefix is in the AAD too, so a `cp-kms-2` blob cannot be
 * relabelled `cp-kms-1` and fed to this code.
 *
 * ## This file knows nothing about AWS
 *
 * It is handed a data key as bytes, so the format stays testable offline and
 * swapping KMS for Vault changes `key-wrapper.ts` only.
 */

/** Version prefix. A future format is a new constant, never a silent change. */
export const ENVELOPE_VERSION = 'cp-kms-1';

const SEGMENT_SEPARATOR = '.';
const SEGMENT_COUNT = 5;
/** GCM's standard nonce size, fixed here so a stored envelope is self-describing. */
const IV_BYTES = 12;
/** GCM's full tag: verifying it is the only thing stopping a tampered blob. */
const TAG_BYTES = 16;
/** AES-256. */
const DATA_KEY_BYTES = 32;
/** A Stellar StrKey secret seed is always exactly this long. */
const SEED_BYTES = 56;
/**
 * Lower bound for the wrapped data key, not an exact length.
 *
 * What KMS returns is an opaque blob - 116 bytes for an AES-256 data key today -
 * and AWS does not promise a size, so pinning it would turn a KMS-side change into
 * an outage. A floor still catches truncation and a swapped-in empty value; a blob
 * that is the wrong *kind* of blob is rejected by KMS itself, which is the only
 * component that can tell.
 */
const MIN_WRAPPED_DATA_KEY_BYTES = 64;
/** Strict base64url: Node's decoder silently ignores characters it does not know. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Why an envelope could not be opened. Machine-readable, and safe to log. */
export type EnvelopeFailure =
  | 'unknown-version'
  | 'malformed'
  | 'wrong-length'
  /** The GCM tag did not verify: the blob, its account binding or its version changed. */
  | 'authentication-failed'
  /** KMS refused the pair: the blob was wrapped by another key, or under another context. */
  | 'key-mismatch'
  /** Decrypted fine, but what came out is not a Stellar secret seed. */
  | 'not-a-seed';

/**
 * The stored secret cannot be opened, and the reason is about the data rather than
 * about availability.
 *
 * Every case here means the same thing operationally: stop, and look at the row and
 * the key history - this is not something a retry or a restart fixes. It is
 * deliberately *not* thrown for a KMS outage or a throttled call; those arrive as
 * `KeyCustodyUnavailableError`, because reporting an outage as corruption sends
 * whoever is on call to the wrong place.
 */
export class SecretEnvelopeError extends Error {
  constructor(
    readonly reason: EnvelopeFailure,
    readonly accountId: string,
    options?: { cause?: unknown },
  ) {
    super(`Stored secret for account ${accountId} could not be opened (${reason})`, options);
    this.name = 'SecretEnvelopeError';
  }
}

/** An envelope taken apart, with every length already checked. */
export interface EnvelopeParts {
  readonly version: string;
  readonly wrappedDataKey: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/** The bytes that bind a ciphertext to one account and one envelope version. */
export function envelopeAad(accountId: string): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}:${accountId}`, 'utf8');
}

/**
 * Seals `secretSeed` for `accountId` under `dataKey`, inside an envelope carrying
 * the wrapped form of that data key.
 *
 * The IV is random per call, so sealing one account twice produces different bytes
 * even if a data key were reused - and it is not reused:
 * `SeedCustodyService.createSealedAccount` asks for a fresh data key per account,
 * which is what the Step 18 audit checks when it requires the stored blob to differ
 * per account.
 */
export function sealEnvelope(input: {
  accountId: string;
  secretSeed: string;
  dataKey: Buffer;
  wrappedDataKey: Buffer;
}): string {
  assertDataKey(input.dataKey, input.accountId);
  assertSeed(input.secretSeed, input.accountId);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', input.dataKey, iv);
  cipher.setAAD(envelopeAad(input.accountId));

  const ciphertext = Buffer.concat([cipher.update(input.secretSeed, 'utf8'), cipher.final()]);

  return [
    ENVELOPE_VERSION,
    input.wrappedDataKey.toString('base64url'),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(SEGMENT_SEPARATOR);
}

/**
 * Takes an envelope apart without touching a key.
 *
 * Separate from `openEnvelope` so the structural checks happen *before* the KMS
 * round trip: a string that is not a `cp-kms-1` envelope at all should not cost a
 * network call, and should not reach a `Decrypt` that could report it as something
 * more alarming than it is.
 *
 * `accountId` is only used for the error message; the binding itself is enforced by
 * the AAD and the KMS context, both of which are recomputed rather than trusted.
 */
export function parseEnvelope(envelope: string, accountId: string): EnvelopeParts {
  const segments = envelope.split(SEGMENT_SEPARATOR);

  if (segments.length !== SEGMENT_COUNT) {
    throw new SecretEnvelopeError('malformed', accountId);
  }

  const [version = '', wrapped = '', iv = '', tag = '', ciphertext = ''] = segments;

  if (version !== ENVELOPE_VERSION) {
    throw new SecretEnvelopeError('unknown-version', accountId);
  }

  if (![wrapped, iv, tag, ciphertext].every((segment) => BASE64URL_PATTERN.test(segment))) {
    throw new SecretEnvelopeError('malformed', accountId);
  }

  const parts: EnvelopeParts = {
    version,
    wrappedDataKey: Buffer.from(wrapped, 'base64url'),
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
  };

  const lengthIsWrong =
    parts.wrappedDataKey.length < MIN_WRAPPED_DATA_KEY_BYTES ||
    parts.iv.length !== IV_BYTES ||
    parts.tag.length !== TAG_BYTES ||
    parts.ciphertext.length !== SEED_BYTES;

  if (lengthIsWrong) {
    throw new SecretEnvelopeError('wrong-length', accountId);
  }

  return parts;
}

/**
 * Recovers the seed from `parts` with `dataKey`.
 *
 * Fails with `authentication-failed` if anything about the ciphertext, the tag, the
 * version or the account binding has changed - the caller never sees a plaintext
 * that did not verify.
 */
export function openEnvelope(input: {
  accountId: string;
  parts: EnvelopeParts;
  dataKey: Buffer;
}): string {
  assertDataKey(input.dataKey, input.accountId);

  try {
    const decipher = createDecipheriv('aes-256-gcm', input.dataKey, input.parts.iv);
    decipher.setAAD(envelopeAad(input.accountId));
    decipher.setAuthTag(input.parts.tag);

    return Buffer.concat([
      decipher.update(input.parts.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new SecretEnvelopeError('authentication-failed', input.accountId, { cause });
  }
}

function assertDataKey(dataKey: Buffer, accountId: string): void {
  if (dataKey.length !== DATA_KEY_BYTES) {
    // Not a `wrong-length` *envelope* failure: the data key is not part of the
    // envelope, and a wrong size here can only be a bug or a KMS answer that is not
    // the data key that was asked for.
    throw new SecretEnvelopeError('malformed', accountId, {
      cause: new Error(`expected a ${DATA_KEY_BYTES}-byte data key, got ${dataKey.length} bytes`),
    });
  }
}

function assertSeed(secretSeed: string, accountId: string): void {
  const bytes = Buffer.from(secretSeed, 'utf8');

  if (bytes.length !== SEED_BYTES || !secretSeed.startsWith('S')) {
    throw new SecretEnvelopeError('not-a-seed', accountId);
  }
}
