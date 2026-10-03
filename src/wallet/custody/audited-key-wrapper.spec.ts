import { describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
import { AuditedKeyWrapper } from './audited-key-wrapper.js';
import {
  KeyCustodyUnavailableError,
  type KeyDescription,
  type KeyWrapper,
  type UnwrapDataKeyRequest,
  type WrapDataKeyRequest,
  type WrappedDataKey,
} from './key-wrapper.js';

/**
 * The decorator over the key port, with both sides substituted: what it records, and - the half that
 * is easy to get wrong - what it changes.
 *
 * Every assertion here is about a property a *decorator* has to have. It sees what the port sees
 * (`accountId`, an ARN, opaque buffers) and nothing that `SeedCustodyService` sees, so it cannot
 * leak a seed into the table: not because it is careful, but because it never has one. It hands
 * return values through *by identity*, so the plaintext data key a caller receives is the buffer KMS
 * produced and not a copy this class made. And it rethrows the custody error untouched, because
 * auditing a call must not change what the call did.
 *
 * The failure branch is the one the class docstring argues is the interesting half of the pair: a
 * wrap that happened is bookkeeping, while a KMS call that *did not happen* is what an operator
 * reads the table for. So a refused call is asserted here with the same care as a successful one -
 * including the classification, which is a short non-sensitive name and never an unmapped SDK
 * message.
 */

const ACCOUNT_ID = '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70';
const KEY_ARN = 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-0000-0000-000000000000';

/** The port, with the two switches a test needs: what it answers, and whether it fails. */
class FakeInner implements KeyWrapper {
  readonly wraps: WrapDataKeyRequest[] = [];
  readonly unwraps: UnwrapDataKeyRequest[] = [];
  describes = 0;

  /** Useless without KMS, and never inspected by the decorator. */
  wrapped: WrappedDataKey = {
    dataKey: Buffer.from('plaintext-data-key'),
    wrappedDataKey: Buffer.from('wrapped-data-key'),
    keyArn: KEY_ARN,
  };

  dataKey = Buffer.from('plaintext-data-key');

  /** Set to make the next call fail: the outage, the disabled key, the wrong region. */
  refusal: Error | null = null;

  wrapDataKey = async (request: WrapDataKeyRequest): Promise<WrappedDataKey> => {
    this.wraps.push(request);

    if (this.refusal !== null) {
      throw this.refusal;
    }

    return this.wrapped;
  };

  unwrapDataKey = async (request: UnwrapDataKeyRequest): Promise<Buffer> => {
    this.unwraps.push(request);

    if (this.refusal !== null) {
      throw this.refusal;
    }

    return this.dataKey;
  };

  describeMasterKey = async (): Promise<KeyDescription> => {
    this.describes += 1;

    return { arn: KEY_ARN, region: 'eu-west-1', keyState: 'Enabled' };
  };
}

/** `AuditService`, recording instead of inserting. */
class FakeAudit {
  readonly entries: AuditEntry[] = [];

  log = async (entry: AuditEntry): Promise<void> => {
    this.entries.push(entry);
  };
}

function wrapperOver(inner: FakeInner): { wrapper: AuditedKeyWrapper; audit: FakeAudit } {
  const audit = new FakeAudit();

  return { wrapper: new AuditedKeyWrapper(inner, audit as unknown as AuditService), audit };
}

describe('a wrap', () => {
  it('appends custody.key.wrapped with the account and the ARN KMS actually used', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);

    await wrapper.wrapDataKey({ accountId: ACCOUNT_ID });

    // The ARN comes from the response rather than from configuration, which is what makes a
    // rotation visible in the table: the row names the key that *can* open the blob.
    expect(audit.entries).toEqual([
      {
        action: 'custody.key.wrapped',
        subjectId: ACCOUNT_ID,
        outcome: 'ok',
        metadata: { keyArn: KEY_ARN },
      },
    ]);
  });

  it('hands the caller the object KMS produced, not a copy of it', async () => {
    const inner = new FakeInner();
    const { wrapper } = wrapperOver(inner);

    const wrapped = await wrapper.wrapDataKey({ accountId: ACCOUNT_ID });

    // Identity, because the alternative is a class that copies plaintext key material around - and
    // because a caller that zeroes the buffer it received has to have zeroed the real one.
    expect(wrapped).toBe(inner.wrapped);
  });

  it('never puts the key material in the entry, because it never reads it', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);

    await wrapper.wrapDataKey({ accountId: ACCOUNT_ID });

    // The plaintext data key is the one value in this class that must never be recorded anywhere,
    // and the entry is what support reads - so this is asserted rather than reasoned about.
    const recorded = JSON.stringify(audit.entries);

    expect(recorded).not.toContain(inner.wrapped.dataKey.toString('base64'));
    expect(recorded).not.toContain(inner.wrapped.dataKey.toString('utf8'));
  });

  it('appends the failure and rethrows the custody error untouched', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);
    inner.refusal = new KeyCustodyUnavailableError('wrap', 'AggregateError (ECONNREFUSED)');

    // The same instance, not a re-wrapped one: the error's `operation` and `detail` are what callers
    // branch and log on, and a decorator that rebuilt it would have changed the contract it exists
    // to observe.
    await expect(wrapper.wrapDataKey({ accountId: ACCOUNT_ID })).rejects.toBe(inner.refusal);

    expect(audit.entries).toEqual([
      {
        action: 'custody.key.wrapped',
        subjectId: ACCOUNT_ID,
        outcome: 'failed',
        metadata: { detail: 'KeyCustodyUnavailableError: AggregateError (ECONNREFUSED)' },
      },
    ]);
  });
});

describe('an unwrap', () => {
  it('appends custody.key.unwrapped with the ARN the row named', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);

    const dataKey = await wrapper.unwrapDataKey({
      accountId: ACCOUNT_ID,
      keyArn: KEY_ARN,
      wrappedDataKey: Buffer.from('wrapped-data-key'),
    });

    expect(dataKey).toBe(inner.dataKey);
    expect(audit.entries).toEqual([
      {
        action: 'custody.key.unwrapped',
        subjectId: ACCOUNT_ID,
        outcome: 'ok',
        metadata: { keyArn: KEY_ARN },
      },
    ]);
  });

  it('classifies an unrecognised failure by class name, never by its message', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);
    // An unmapped error is a string from an SDK that nobody in this repository has reviewed, and it
    // can carry anything - including the very material this class exists to keep out of the table.
    const leaked = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    inner.refusal = new TypeError(`could not read ${leaked}`);

    await expect(
      wrapper.unwrapDataKey({
        accountId: ACCOUNT_ID,
        keyArn: KEY_ARN,
        wrappedDataKey: Buffer.from('wrapped-data-key'),
      }),
    ).rejects.toBe(inner.refusal);

    // The class name, and the ARN the caller asked about - which is the useful context when a
    // *decrypt* fails - and nothing else.
    expect(audit.entries).toEqual([
      {
        action: 'custody.key.unwrapped',
        subjectId: ACCOUNT_ID,
        outcome: 'failed',
        metadata: { detail: 'TypeError', keyArn: KEY_ARN },
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(leaked);
  });
});

describe('what is deliberately not an event', () => {
  it('passes the boot probe through without an entry', async () => {
    const inner = new FakeInner();
    const { wrapper, audit } = wrapperOver(inner);

    await expect(wrapper.describeMasterKey()).resolves.toMatchObject({ keyState: 'Enabled' });

    // Metadata about the master key, read once per process at boot, is not an access to key
    // material: a row per deploy would be noise around the two events that matter.
    expect(audit.entries).toEqual([]);
    expect(inner.describes).toBe(1);
  });
});
