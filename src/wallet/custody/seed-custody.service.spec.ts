import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, type Mock, vi } from 'vitest';
import type { StellarService } from '../stellar/stellar.service.js';
import {
  KeyCustodyUnavailableError,
  type KeyWrapper,
  type UnwrapDataKeyRequest,
  type WrapDataKeyRequest,
  type WrappedDataKey,
} from './key-wrapper.js';
import { SecretEnvelopeError } from './secret-envelope.js';
import { SeedCustodyService, type SealedAccount } from './seed-custody.service.js';

/**
 * What this spec is really about is the two things the service promises that nothing else
 * can check: a fresh data key per account (never one key reused across rows), and a data
 * key that lives only as long as the call that needed it.
 *
 * The wrapper is faked, and the fake is deliberately as strict as KMS. It remembers which
 * data key it wrapped *for which account*, refuses to hand it back to any other account,
 * refuses an ARN it did not record, and returns a fresh copy of the bytes every time - as
 * KMS does. A permissive fake would let the service pass a wrong account id or a stale ARN
 * and still look correct, which is the whole class of bug this step exists to rule out.
 */

const MASTER_KEY_ARN =
  'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';

/**
 * A `KeyWrapper` that is as strict as KMS and remembers what it was asked.
 *
 * The two methods are typed as the *mock* of their signature rather than as vitest's
 * `ReturnType<typeof vi.fn>`, which is its widest default (`Mock<Procedure | Constructable>`)
 * and has no call signature - so a fake declared that way never actually satisfied
 * `KeyWrapper`, and this fixture did not type-check. The signatures are restated rather than
 * inferred on purpose: a change to the port should now fail *here*, in the fake, instead of
 * silently widening what the fake is allowed to be.
 */
interface FakeKeyWrapper extends KeyWrapper {
  /** The plaintext data keys handed out, so a spec can check what happened to them. */
  readonly handedOut: Buffer[];
  wrapDataKey: Mock<(request: WrapDataKeyRequest) => Promise<WrappedDataKey>>;
  unwrapDataKey: Mock<(request: UnwrapDataKeyRequest) => Promise<Buffer>>;
}

function fakeKeyWrapper(): FakeKeyWrapper {
  /** Wrapped key -> the account and key bytes it belongs to, as KMS would hold them. */
  const wrapped = new Map<string, { accountId: string; dataKey: Buffer }>();
  const handedOut: Buffer[] = [];
  let counter = 0;

  const wrapDataKey = vi.fn(async ({ accountId }: WrapDataKeyRequest): Promise<WrappedDataKey> => {
    counter += 1;
    // A fresh key on every call. An implementation that returned one shared data key would
    // have to fail the specs below, because a shared key is exactly what the Step 18 audit
    // looks for in the stored blobs.
    const dataKey = Buffer.alloc(32, counter);
    const wrappedDataKey = Buffer.alloc(116, counter);

    // A copy, not the caller's buffer: KMS keeps its own, which is why zeroing the
    // plaintext after use is worth doing and is asserted below.
    wrapped.set(wrappedDataKey.toString('base64url'), { accountId, dataKey: Buffer.from(dataKey) });
    handedOut.push(dataKey);

    return { dataKey, wrappedDataKey, keyArn: MASTER_KEY_ARN };
  });

  const unwrapDataKey = vi.fn(
    async ({ accountId, keyArn, wrappedDataKey }: UnwrapDataKeyRequest): Promise<Buffer> => {
      if (keyArn !== MASTER_KEY_ARN) {
        throw new Error(`unexpected key arn ${keyArn}`);
      }

      const entry = wrapped.get(wrappedDataKey.toString('base64url'));

      if (!entry || entry.accountId !== accountId) {
        // What KMS answers here: a wrong `EncryptionContext` arrives as
        // `InvalidCiphertextException` and a wrong `KeyId` as `IncorrectKeyException`.
        throw new Error('the wrapped key does not belong to this account');
      }

      return Buffer.from(entry.dataKey);
    },
  );

  const describeMasterKey = vi.fn(async () => ({
    arn: MASTER_KEY_ARN,
    region: 'eu-west-1',
    keyState: 'Enabled',
  }));

  return { wrapDataKey, unwrapDataKey, describeMasterKey, handedOut };
}

/** Only `generateKeypair` is used, so only that is provided. */
function fakeStellar(): StellarService {
  return { generateKeypair: () => Keypair.random() } as unknown as StellarService;
}

function serviceWith(wrapper: KeyWrapper): SeedCustodyService {
  return new SeedCustodyService(wrapper, fakeStellar());
}

function rowOf(sealed: SealedAccount): {
  id: string;
  encryptedSecretKey: string;
  dataKeyArn: string;
} {
  return {
    id: sealed.accountId,
    encryptedSecretKey: sealed.encryptedSecretKey,
    dataKeyArn: sealed.dataKeyArn,
  };
}

/** The same envelope with one segment replaced, for the tampering cases below. */
function withSegment(envelope: string, index: number, value: string): string {
  const segments = envelope.split('.');
  segments[index] = value;

  return segments.join('.');
}

describe('SeedCustodyService.createSealedAccount', () => {
  it('returns an account whose secret only exists as an envelope', async () => {
    const sealed = await serviceWith(fakeKeyWrapper()).createSealedAccount();

    // The id is generated here rather than by the database default, because the seed is
    // bound to it: it has to exist before the seal does.
    expect(sealed.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sealed.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(sealed.encryptedSecretKey.startsWith('cp-kms-1.')).toBe(true);
    expect(sealed.dataKeyArn).toBe(MASTER_KEY_ARN);
  });

  it('round trips: the envelope opens back to the same account', async () => {
    const service = serviceWith(fakeKeyWrapper());
    const sealed = await service.createSealedAccount();

    const opened = await service.openSeed(rowOf(sealed));

    expect(opened.publicKey()).toBe(sealed.publicKey);
  });

  it('keeps the seed out of everything it returns', async () => {
    const service = serviceWith(fakeKeyWrapper());
    const sealed = await service.createSealedAccount();

    // The audit's log grep, in miniature. A Stellar seed is `S` plus 55 base32 characters,
    // so anything carrying one - a returned field, or an object serialised into a log line -
    // matches this.
    expect(JSON.stringify(sealed)).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it('asks for a new data key for every account', async () => {
    const wrapper = fakeKeyWrapper();
    const service = serviceWith(wrapper);

    const first = await service.createSealedAccount();
    const second = await service.createSealedAccount();

    expect(wrapper.wrapDataKey).toHaveBeenCalledTimes(2);
    expect(first.accountId).not.toBe(second.accountId);

    // Not merely a different IV: the *wrapped* key differs, which is what proves a fresh
    // data key rather than one key reused under a fresh nonce.
    const wrappedOf = (sealed: SealedAccount): string =>
      sealed.encryptedSecretKey.split('.')[1] ?? '';

    expect(wrappedOf(first)).not.toBe(wrappedOf(second));

    // And each was asked for under its own account, which is the KMS EncryptionContext.
    expect(wrapper.wrapDataKey.mock.calls.map(([request]) => request.accountId)).toEqual([
      first.accountId,
      second.accountId,
    ]);
  });

  it('zeroes the data key as soon as the seed is sealed', async () => {
    const wrapper = fakeKeyWrapper();

    await serviceWith(wrapper).createSealedAccount();

    expect(wrapper.handedOut[0]).toEqual(Buffer.alloc(32));
  });
});

describe('SeedCustodyService.openSeed', () => {
  it('unwraps with the account id and the key reference the row records', async () => {
    const wrapper = fakeKeyWrapper();
    const service = serviceWith(wrapper);
    const sealed = await service.createSealedAccount();
    wrapper.unwrapDataKey.mockClear();

    await service.openSeed(rowOf(sealed));

    const [request] = wrapper.unwrapDataKey.mock.calls[0];

    expect(request.accountId).toBe(sealed.accountId);
    // The ARN from the row, not from configuration: that is what makes the stored reference
    // worth having, and what a rotation would change.
    expect(request.keyArn).toBe(sealed.dataKeyArn);
    expect(request.wrappedDataKey.toString('base64url')).toBe(
      sealed.encryptedSecretKey.split('.')[1],
    );
  });

  it('refuses a whole blob lifted onto another row', async () => {
    const service = serviceWith(fakeKeyWrapper());
    const first = await service.createSealedAccount();
    const second = await service.createSealedAccount();

    // The shape a database-write attacker has: one row's entire envelope moved onto
    // another's. The KMS encryption context is what stops this - the wrapped data key was
    // minted for a different account, so it is refused before any ciphertext is touched.
    // Against a real KMS that refusal is `InvalidCiphertextException`, which
    // `KmsKeyWrapper` maps to `SecretEnvelopeError('key-mismatch')`; that mapping is the
    // wrapper spec's subject, and the live case is in the opt-in integration spec.
    const failed = await service
      .openSeed({ ...rowOf(first), encryptedSecretKey: second.encryptedSecretKey })
      .catch((error: unknown) => error);

    // No keypair and no secret: whatever the wrapper said, the caller gets a failure.
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(Keypair);
  });

  it('refuses a ciphertext moved between rows that both unwrap cleanly', async () => {
    const service = serviceWith(fakeKeyWrapper());
    const first = await service.createSealedAccount();
    const second = await service.createSealedAccount();
    const secondCiphertext = second.encryptedSecretKey.split('.')[4] ?? '';

    // Only the ciphertext is swapped, so each row's wrapped data key still belongs to the row
    // it sits on and KMS answers happily. That leaves the second binding - the AES-GCM
    // additional authenticated data - which fails locally, without a KMS call at all.
    const failed = await service
      .openSeed({
        ...rowOf(first),
        encryptedSecretKey: withSegment(first.encryptedSecretKey, 4, secondCiphertext),
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SecretEnvelopeError);
    expect((failed as SecretEnvelopeError).reason).toBe('authentication-failed');
  });

  it('fails on a malformed envelope without asking KMS', async () => {
    const wrapper = fakeKeyWrapper();
    const service = serviceWith(wrapper);

    const failed = await service
      .openSeed({
        id: 'f0b1f3ba-6a9b-4a1b-9f4c-6dcb1e2a1234',
        encryptedSecretKey: 'garbage',
        dataKeyArn: MASTER_KEY_ARN,
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SecretEnvelopeError);
    // A string that is not an envelope at all must not cost a network call, and must not
    // reach a `Decrypt` that could report it as something more alarming than it is.
    expect(wrapper.unwrapDataKey).not.toHaveBeenCalled();
  });

  it('propagates an unavailable KMS unchanged, as an outage rather than corruption', async () => {
    const wrapper = fakeKeyWrapper();
    const service = serviceWith(wrapper);
    const sealed = await service.createSealedAccount();
    const outage = new KeyCustodyUnavailableError('unwrap', 'AggregateError (ECONNREFUSED)');
    wrapper.unwrapDataKey.mockRejectedValueOnce(outage);

    const failed = await service.openSeed(rowOf(sealed)).catch((error: unknown) => error);

    // The same instance, not a re-wrapped copy: whoever is on call needs the operation and
    // the cause intact, and needs to see that this is not a problem with the stored data.
    expect(failed).toBe(outage);
    expect(failed).not.toBeInstanceOf(SecretEnvelopeError);
  });

  it('zeroes the data key it unwrapped', async () => {
    const wrapper = fakeKeyWrapper();
    const service = serviceWith(wrapper);
    const sealed = await service.createSealedAccount();
    const unwrapped: Buffer[] = [];
    const unwrap = wrapper.unwrapDataKey.getMockImplementation() as (
      request: UnwrapDataKeyRequest,
    ) => Promise<Buffer>;

    wrapper.unwrapDataKey.mockImplementation(async (request: UnwrapDataKeyRequest) => {
      const dataKey = await unwrap(request);
      unwrapped.push(dataKey);

      return dataKey;
    });

    await service.openSeed(rowOf(sealed));

    expect(unwrapped[0]).toEqual(Buffer.alloc(32));
  });
});
