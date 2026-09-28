/**
 * The seam between "one account's seed, encrypted under a data key" (Step 18) and
 * "whatever holds the master key".
 *
 * `SeedCustodyService` never imports an AWS client: it asks this port for a data
 * key, and the only implementation - `KmsKeyWrapper` - is the single file in the
 * app that knows `@aws-sdk/client-kms` exists. That is what keeps `npm test`
 * offline (the specs substitute a fake wrapper) and what would let a Vault
 * implementation land without touching the envelope format or the service.
 *
 * The failures this port may produce are declared here, beside the contract,
 * rather than in the AWS file: they are part of what a caller has to handle, and
 * `seed-custody.service.spec.ts` asserts the service's reaction to them without
 * importing anything AWS-shaped. They are split by the reaction they demand, the
 * same reasoning `account-source.ts` records for the two Stellar errors:
 *
 * - `KeyCustodyUnavailableError` - the operation did not happen and no key
 *   material was produced, so nothing about the stored row is in question. Usually
 *   transient (KMS unreachable, throttling, credentials) but it also covers a key
 *   that is disabled and a policy that denies this principal: retrying will not fix
 *   those, a human will. The important part is what it is *not*: corruption.
 * - `KmsKeyNotFoundError` - the key *reference* does not resolve: wrong region,
 *   deleted key, malformed ARN. This is configuration, not an outage, which is why
 *   `KmsKeyWrapper` refuses to start in production on it.
 * - `SecretEnvelopeError` (declared in `secret-envelope.ts`) - the stored blob
 *   cannot be opened with the key and the binding its row names. Tampering, a
 *   failed rotation, or a bug: stop everything.
 */

/**
 * The data-key source `SeedCustodyService` depends on. Bound to `KmsKeyWrapper` in
 * `WalletModule` and to a fake in the service spec.
 */
export const KEY_WRAPPER = Symbol('KEY_WRAPPER');

/** Which call failed. Carried on the error so a log line names the operation. */
export type CustodyOperation = 'wrap' | 'unwrap' | 'describe';

/** A data key, wrapped by the master key, for one account. */
export interface WrappedDataKey {
  /**
   * The plaintext data key, in memory only. The caller owns it and is expected to
   * zero it as soon as the seed is sealed (`SeedCustodyService` does).
   */
  readonly dataKey: Buffer;
  /** The wrapped form: what goes in the envelope. Keepable, and useless without KMS. */
  readonly wrappedDataKey: Buffer;
  /**
   * The master key that actually wrapped it, as the resolved ARN.
   *
   * Taken from KMS's own answer rather than from configuration, because config may
   * name the key by alias or bare id - and a row has to record the key that *can*
   * open it, not the name it was asked for. KMS keys are regional, so this is also
   * the value that makes a wrong-region deployment fail at `Decrypt` instead of
   * silently wrapping under a key somewhere else.
   */
  readonly keyArn: string;
}

/**
 * Which account a data key belongs to.
 *
 * `accountId` is not decoration: it travels as the KMS `EncryptionContext` on the
 * wrapped data key *and* as the AES-GCM additional authenticated data on the seed,
 * so a blob moved to another account's row fails in two independent places.
 */
export interface WrapDataKeyRequest {
  readonly accountId: string;
}

export interface UnwrapDataKeyRequest {
  readonly accountId: string;
  /** The ARN stored on the row: which key is allowed to open this blob. */
  readonly keyArn: string;
  readonly wrappedDataKey: Buffer;
}

/** What the boot probe learned about the configured master key. */
export interface KeyDescription {
  readonly arn: string;
  /** Parsed out of `arn`; `undefined` if the endpoint answered something non-ARN. */
  readonly region: string | undefined;
  /** KMS's own word for it: `Enabled`, `Disabled`, `PendingDeletion`. */
  readonly keyState: string;
}

export interface KeyWrapper {
  /** A fresh data key for `accountId`, wrapped by the master key. */
  wrapDataKey(request: WrapDataKeyRequest): Promise<WrappedDataKey>;

  /**
   * Recovers a data key previously wrapped for `accountId` under `keyArn`.
   *
   * The ARN is a required argument rather than something the wrapper looks up in
   * config, so a row can only be opened by the key it says wrapped it - which is
   * what makes the reference column worth storing.
   */
  unwrapDataKey(request: UnwrapDataKeyRequest): Promise<Buffer>;

  /** The configured master key, as KMS describes it. Used by the boot probe. */
  describeMasterKey(): Promise<KeyDescription>;
}

/**
 * Custody is not usable: the call did not happen, or will keep not happening until
 * somebody changes something. Never a statement about the stored data.
 *
 * `detail` is a short, non-sensitive classification (`NotFoundException`,
 * `AggregateError (ECONNREFUSED)`, `the master key is disabled`) because the SDK
 * leaves some failures with an empty message - a refused connection arrives as an
 * `AggregateError` whose `message` is `''`, which is useless in a log line.
 */
export class KeyCustodyUnavailableError extends Error {
  constructor(
    readonly operation: CustodyOperation,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Key custody ${operation} failed: ${detail}`, options);
    this.name = 'KeyCustodyUnavailableError';
  }
}

/**
 * The configured key reference does not resolve.
 *
 * Kept separate from `KeyCustodyUnavailableError` even though both stop the call,
 * because the reaction differs: an outage is a wait, this is a deploy that has to be
 * fixed. The most common cause is not even a wrong key - it is a *cross-region* one,
 * since KMS keys are regional and AWS reports an ARN from another region as
 * `NotFoundException`, with no hint that the region is the problem.
 */
export class KmsKeyNotFoundError extends Error {
  constructor(
    readonly keyId: string,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`KMS key ${keyId} is not usable: ${detail}`, options);
    this.name = 'KmsKeyNotFoundError';
  }
}
