import { AuditService } from '../../audit/audit.service.js';
import {
  KmsKeyNotFoundError,
  KeyCustodyUnavailableError,
  type KeyDescription,
  type KeyWrapper,
  type UnwrapDataKeyRequest,
  type WrapDataKeyRequest,
  type WrappedDataKey,
} from './key-wrapper.js';

/**
 * Records every key-access event, by wrapping the port rather than by editing either side of it
 * (Step 32).
 *
 * ## Why a decorator, and not a call inside `KmsKeyWrapper` or `SeedCustodyService`
 *
 * Both of those were considered and both would have been worse. `KmsKeyWrapper` is documented as
 * the one file in the app that knows AWS exists; giving it a database client would make the audit
 * a side effect of an adapter that is supposed to be swappable - a Vault implementation would
 * silently stop being audited. `SeedCustodyService` is documented as logging nothing and holding
 * no state because everything near it is a secret; giving the class that holds the seed a database
 * handle is the wrong direction for the isolation §5.1 of the review is about.
 *
 * A decorator is the third option and the only one that leaves both untouched: it sees exactly
 * what the port sees (`accountId`, an ARN, opaque buffers) and nothing that `SeedCustodyService`
 * sees. It is bound *over* the port in `WalletModule`, so it cannot be bypassed by a caller -
 * `SeedCustodyService` is the port's only consumer, and this is what that consumer is given.
 *
 * ## The failure is the interesting half
 *
 * A successful wrap is bookkeeping; a KMS call that *did not happen* is the event an operator
 * wants to see, and this decorator is the only place that can see both outcomes and still know
 * whose key it was. So the entry is written either way, with `outcome: 'ok' | 'failed'`, and the
 * error is rethrown untouched - auditing a call must not change what the call did.
 *
 * ## What it does not do
 *
 * - It never inspects, copies, retains or logs a return value. `wrapDataKey` hands back a
 *   plaintext data key, and this class passes the object straight through: it reads `keyArn` (an
 *   ARN, not a secret) and nothing else.
 * - It does not audit `describeMasterKey`. That call reads the master key's *metadata* - ARN,
 *   region, state - on the boot probe, once per process, and it is not an access to key material.
 *   A row per deploy would be noise around the two events that matter.
 * - It never throws because of the audit. `AuditService.log` swallows its own failures, and the
 *   `catch` here rethrows the *custody* error, which is the only error this class is allowed to
 *   change the shape of.
 *
 * A plain class rather than `@Injectable()`: `WalletModule` builds it with a factory that names
 * its two dependencies explicitly, which is also the only place the bindings (`KmsKeyWrapper`,
 * `AuditService`) are visible together. Decorating it would imply Nest resolves it.
 */
export class AuditedKeyWrapper implements KeyWrapper {
  constructor(
    private readonly inner: KeyWrapper,
    private readonly audit: AuditService,
  ) {}

  async wrapDataKey(request: WrapDataKeyRequest): Promise<WrappedDataKey> {
    try {
      const wrapped = await this.inner.wrapDataKey(request);

      await this.audit.log({
        action: 'custody.key.wrapped',
        subjectId: request.accountId,
        outcome: 'ok',
        // The resolved ARN, which is the one thing from the response that is not key material and
        // the value the row will store - so a rotation that changed it shows up here too.
        metadata: { keyArn: wrapped.keyArn },
      });

      return wrapped;
    } catch (error) {
      await this.audit.log({
        action: 'custody.key.wrapped',
        subjectId: request.accountId,
        outcome: 'failed',
        metadata: { detail: classify(error) },
      });

      throw error;
    }
  }

  async unwrapDataKey(request: UnwrapDataKeyRequest): Promise<Buffer> {
    try {
      const dataKey = await this.inner.unwrapDataKey(request);

      await this.audit.log({
        action: 'custody.key.unwrapped',
        subjectId: request.accountId,
        outcome: 'ok',
        metadata: { keyArn: request.keyArn },
      });

      return dataKey;
    } catch (error) {
      await this.audit.log({
        action: 'custody.key.unwrapped',
        subjectId: request.accountId,
        outcome: 'failed',
        metadata: { detail: classify(error), keyArn: request.keyArn },
      });

      throw error;
    }
  }

  /** Not audited: see the class docstring. Passed through without a call of its own. */
  describeMasterKey(): Promise<KeyDescription> {
    return this.inner.describeMasterKey();
  }
}

/**
 * A short, non-sensitive name for what went wrong.
 *
 * The two custody errors' `detail` fields exist precisely for this - `key-wrapper.ts` says so, and
 * they are already written into log lines - while an unrecognised error contributes only its
 * *class name*. `error.message` is deliberately never used: this string is stored in a table that
 * support reads, and an unmapped message is a string from an SDK that nobody has reviewed.
 */
function classify(error: unknown): string {
  if (error instanceof KeyCustodyUnavailableError || error instanceof KmsKeyNotFoundError) {
    return `${error.name}: ${error.detail}`;
  }

  return error instanceof Error ? error.name : 'unknown failure';
}
