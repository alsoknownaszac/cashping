import { ConfigService } from '@nestjs/config';
import {
  DisabledException,
  IncorrectKeyException,
  InvalidArnException,
  InvalidCiphertextException,
  KMSClient,
  NotFoundException,
} from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import { KmsKeyNotFoundError, KeyCustodyUnavailableError } from './key-wrapper.js';
import {
  KmsKeyWrapper,
  classifyKmsFailure,
  createKmsClient,
  describeFailure,
  regionOf,
} from './kms-key-wrapper.js';
import { SecretEnvelopeError } from './secret-envelope.js';

/**
 * This file is the only place AWS failures are interpreted, so the mapping is the thing
 * worth testing - and it is tested with the SDK's own exception classes rather than with
 * look-alikes, because the mapping matches on `name` and a hand-rolled `{ name: ... }`
 * object would prove nothing about what `@aws-sdk/client-kms` actually throws.
 *
 * The `AggregateError` case is the one the spike turned up: a refused connection arrives
 * with an *empty* message, so nothing about it can be matched on text. It is matched on the
 * Node error code instead.
 */

const KEY_ID = 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const OTHER_KEY_ID = 'arn:aws:kms:eu-west-1:123456789012:key/9876fedc-ba98-7654-3210-fedcba987654';
const ACCOUNT = 'f0b1f3ba-6a9b-4a1b-9f4c-6dcb1e2a1234';

/** What a refused socket looks like coming out of the SDK: no message, only a code. */
function connectionRefused(): Error {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4566'), {
    code: 'ECONNREFUSED',
  });

  return Object.assign(new AggregateError([refused], ''), { code: 'ECONNREFUSED' });
}

interface FakeClient {
  client: KMSClient;
  send: ReturnType<typeof vi.fn>;
}

function fakeClient(): FakeClient {
  const send = vi.fn();

  return { client: { send } as unknown as KMSClient, send };
}

function configWith(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    'aws.region': 'eu-west-1',
    'aws.endpointUrl': undefined,
    'aws.accessKeyId': 'AKIAIOSFODNN7EXAMPLE',
    'aws.secretAccessKey': 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'aws.kmsKeyId': KEY_ID,
    nodeEnv: 'test',
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`unexpected config key ${key}`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

function wrapperWith(
  client: FakeClient,
  overrides?: Record<string, string | undefined>,
): { wrapper: KmsKeyWrapper; factory: ReturnType<typeof vi.fn> } {
  const factory = vi.fn(() => client.client);

  return { wrapper: new KmsKeyWrapper(configWith(overrides), factory), factory };
}

describe('classifying a KMS failure', () => {
  it('reads a key reference that does not resolve as configuration', () => {
    expect(classifyKmsFailure(new NotFoundException({ $metadata: {}, message: 'not found' }))).toBe(
      'key-not-found',
    );
    expect(classifyKmsFailure(new InvalidArnException({ $metadata: {}, message: 'bad arn' }))).toBe(
      'key-not-found',
    );
  });

  it('reads a blob that does not match its key or context as an envelope failure', () => {
    expect(
      classifyKmsFailure(new IncorrectKeyException({ $metadata: {}, message: 'wrong key' })),
    ).toBe('envelope');
    // A wrong encryption context arrives under this name: KMS has no error of its own for
    // it, which is why the classifier has one entry covering both.
    expect(
      classifyKmsFailure(new InvalidCiphertextException({ $metadata: {}, message: 'bad context' })),
    ).toBe('envelope');
  });

  it('reads a refused connection as unavailable, off the Node error code', () => {
    const refused = connectionRefused();

    // The shape that makes message-matching useless: empty message, name and code only.
    expect(refused.message).toBe('');
    expect(classifyKmsFailure(refused)).toBe('unavailable');
    expect(describeFailure(refused)).toBe('AggregateError (ECONNREFUSED)');

    // The same failure in its other shape, and the reason the match is on the code rather
    // than the name: against a single-address endpoint the SDK throws a plain `Error` with the
    // code, no `AggregateError` and no message either. Observed live in
    // `test/custody.e2e-spec.ts`, against an endpoint with nothing listening on it.
    const direct = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4599'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyKmsFailure(direct)).toBe('unavailable');
    expect(describeFailure(direct)).toBe('Error (ECONNREFUSED)');
  });

  it('reads a disabled key as unavailable rather than as corruption', () => {
    expect(classifyKmsFailure(new DisabledException({ $metadata: {}, message: 'disabled' }))).toBe(
      'unavailable',
    );
  });

  it('never reads an unfamiliar failure as corruption', () => {
    // The deliberate default. Throttling, a policy denial, an expired token, a KMS internal
    // error and anything AWS adds later all land here - because sending somebody to inspect
    // key material during an outage is worse than one extra log line.
    for (const error of [
      Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }),
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
      Object.assign(new Error('token expired'), { name: 'ExpiredTokenException' }),
      new Error('something new'),
      undefined,
      'not an error at all',
    ]) {
      expect(classifyKmsFailure(error)).toBe('unavailable');
    }
  });
});

describe('createKmsClient', () => {
  it('builds a real client for the configured region', async () => {
    const client = createKmsClient({
      region: 'eu-west-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
    });

    expect(client).toBeInstanceOf(KMSClient);
    // The one piece of this worth pinning here: the region reaches the SDK as a provider.
    // The endpoint option is proved against a live emulator in the opt-in integration spec,
    // which is the only place a socket is available.
    expect(await client.config.region()).toBe('eu-west-1');
    client.destroy();
  });
});

describe('regionOf', () => {
  it('reads the region out of a key ARN', () => {
    expect(regionOf(KEY_ID)).toBe('eu-west-1');
    expect(regionOf('arn:aws:kms:ap-southeast-2:123456789012:key/abc')).toBe('ap-southeast-2');
  });

  it('returns undefined for anything that is not a KMS ARN', () => {
    // Never throws: this runs on whatever an endpoint answered, and a probe that crashed on
    // an unexpected shape would be its own outage.
    for (const value of [
      'alias/cashping-seeds',
      '1234abcd-12ab-34cd-56ef-1234567890ab',
      '',
      'nonsense',
    ]) {
      expect(regionOf(value)).toBeUndefined();
    }
  });
});

describe('wrapping a data key', () => {
  it('asks for a 256-bit data key under the account as encryption context', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({
      Plaintext: Buffer.alloc(32, 3),
      CiphertextBlob: Buffer.alloc(116, 4),
      KeyId: KEY_ID,
    });

    const { wrapper } = wrapperWith(fake);
    const wrapped = await wrapper.wrapDataKey({ accountId: ACCOUNT });

    expect(wrapped.dataKey).toEqual(Buffer.alloc(32, 3));
    expect(wrapped.wrappedDataKey).toEqual(Buffer.alloc(116, 4));
    expect(wrapped.keyArn).toBe(KEY_ID);

    const [command] = fake.send.mock.calls[0] as [{ input: Record<string, unknown> }];

    expect(fake.send).toHaveBeenCalledTimes(1);
    // The context is not decoration: it is the binding that makes this blob unusable on any
    // other account's row, and it is verified against a live KMS in the integration spec.
    expect(command.input).toMatchObject({
      KeyId: KEY_ID,
      KeySpec: 'AES_256',
      EncryptionContext: { accountId: ACCOUNT },
    });
  });

  it('records the key KMS resolved, not the name it was asked for', async () => {
    const fake = fakeClient();
    // What KMS answers when the config named an alias or a bare uuid: the resolved ARN. The
    // row gets this, so a row can always be matched to the key that can open it.
    fake.send.mockResolvedValue({
      Plaintext: Buffer.alloc(32, 3),
      CiphertextBlob: Buffer.alloc(116, 4),
      KeyId: KEY_ID,
    });

    const { wrapper } = wrapperWith(fake, { 'aws.kmsKeyId': 'alias/cashping-seeds' });

    await expect(wrapper.wrapDataKey({ accountId: ACCOUNT })).resolves.toMatchObject({
      keyArn: KEY_ID,
    });
  });

  it('builds no client until a call is made, then exactly one from config', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({
      Plaintext: Buffer.alloc(32, 3),
      CiphertextBlob: Buffer.alloc(116, 4),
      KeyId: KEY_ID,
    });

    const { wrapper, factory } = wrapperWith(fake);

    // Merely compiling the module graph must open no socket, or every spec that builds
    // `WalletModule` would depend on KMS.
    expect(factory).not.toHaveBeenCalled();

    await wrapper.wrapDataKey({ accountId: ACCOUNT });
    await wrapper.wrapDataKey({ accountId: ACCOUNT });

    // One client for the life of the process, built from config - including the endpoint and
    // the credentials, so no ambient environment variable can redirect custody.
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      region: 'eu-west-1',
      endpointUrl: undefined,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
  });

  it('treats a response KMS could not have produced as a failed call', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({ CiphertextBlob: Buffer.alloc(116, 4) });

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper.wrapDataKey({ accountId: ACCOUNT }).catch((error: unknown) => error);

    // A seed must never be sealed under a key whose reference cannot be recorded: the row
    // would be unopenable later, silently - and it would look like corruption then.
    expect(failed).toBeInstanceOf(KeyCustodyUnavailableError);
    expect((failed as KeyCustodyUnavailableError).operation).toBe('wrap');
  });

  it('maps a key reference that does not resolve to KmsKeyNotFoundError', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(new NotFoundException({ $metadata: {}, message: 'not found' }));

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper.wrapDataKey({ accountId: ACCOUNT }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KmsKeyNotFoundError);
    expect((failed as KmsKeyNotFoundError).keyId).toBe(KEY_ID);
  });

  it('maps an unreachable endpoint to KeyCustodyUnavailableError, keeping the cause', async () => {
    const fake = fakeClient();
    const refused = connectionRefused();
    fake.send.mockRejectedValue(refused);

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper.wrapDataKey({ accountId: ACCOUNT }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KeyCustodyUnavailableError);
    expect((failed as KeyCustodyUnavailableError).detail).toBe('AggregateError (ECONNREFUSED)');
    expect(failed.cause).toBe(refused);
  });
});

describe('unwrapping a data key', () => {
  it("decrypts with the key reference the row records, under the row's account", async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({ Plaintext: Buffer.alloc(32, 5) });

    const { wrapper } = wrapperWith(fake);
    const dataKey = await wrapper.unwrapDataKey({
      accountId: ACCOUNT,
      keyArn: OTHER_KEY_ID,
      wrappedDataKey: Buffer.alloc(116, 4),
    });

    expect(dataKey).toEqual(Buffer.alloc(32, 5));

    const [command] = fake.send.mock.calls[0] as [{ input: Record<string, unknown> }];

    // `KeyId` is passed even though the blob carries its own reference: it asserts that this
    // row's recorded key is the key that wrapped it, which is how a botched rotation becomes
    // an error instead of a silent decryption under whatever key the blob names.
    expect(command.input).toMatchObject({
      KeyId: OTHER_KEY_ID,
      EncryptionContext: { accountId: ACCOUNT },
    });
  });

  it('reads a row and blob that disagree as an envelope failure, naming the account', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(new IncorrectKeyException({ $metadata: {}, message: 'wrong key' }));

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper
      .unwrapDataKey({
        accountId: ACCOUNT,
        keyArn: OTHER_KEY_ID,
        wrappedDataKey: Buffer.alloc(116, 4),
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SecretEnvelopeError);
    expect((failed as SecretEnvelopeError).reason).toBe('key-mismatch');
    expect((failed as SecretEnvelopeError).accountId).toBe(ACCOUNT);
  });

  it('reads a context mismatch the same way', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(
      new InvalidCiphertextException({ $metadata: {}, message: 'bad context' }),
    );

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper
      .unwrapDataKey({ accountId: ACCOUNT, keyArn: KEY_ID, wrappedDataKey: Buffer.alloc(116, 4) })
      .catch((error: unknown) => error);

    expect((failed as SecretEnvelopeError).reason).toBe('key-mismatch');
  });

  it('never reports a blob-class failure from a call that had no blob', async () => {
    const fake = fakeClient();
    // A `GenerateDataKey` call cannot fail because of stored data, so this must not be
    // reported as corruption even though the error name is blob-class.
    fake.send.mockRejectedValue(new InvalidCiphertextException({ $metadata: {}, message: 'odd' }));

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper.wrapDataKey({ accountId: ACCOUNT }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KeyCustodyUnavailableError);
    expect(failed).not.toBeInstanceOf(SecretEnvelopeError);
  });
});

describe('describing the master key', () => {
  it('reports the resolved ARN, its region and its state', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({ KeyMetadata: { Arn: KEY_ID, KeyState: 'Enabled' } });

    const { wrapper } = wrapperWith(fake);

    await expect(wrapper.describeMasterKey()).resolves.toEqual({
      arn: KEY_ID,
      region: 'eu-west-1',
      keyState: 'Enabled',
    });
  });

  it('treats a response with no key metadata as a failed call, never as a healthy key', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({});

    const { wrapper } = wrapperWith(fake);
    const failed = await wrapper.describeMasterKey().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KeyCustodyUnavailableError);
    expect((failed as KeyCustodyUnavailableError).operation).toBe('describe');
  });
});

/**
 * The boot probe's contract is two rules, not one, and the difference is the whole point:
 * a key reference that *cannot* work is a broken deployment, while an unreachable KMS is a
 * blip - and `main.ts` already decided (Step 3) that a missing dependency must not put the
 * container into a restart loop. So only the first can refuse to start, and only in
 * production.
 */
describe('the boot probe', () => {
  it('refuses to start in production when the key reference cannot work', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(new NotFoundException({ $metadata: {}, message: 'not found' }));

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).rejects.toThrow(/Refusing to start in production/);
  });

  it('refuses to start in production when the key resolves into another region', async () => {
    // The exact misconfiguration the spike hit, at the cost of a detour: a key ARN from
    // another region, which AWS reports as NotFoundException with no mention of the region.
    const fake = fakeClient();
    fake.send.mockResolvedValue({
      KeyMetadata: { Arn: 'arn:aws:kms:us-east-1:123456789012:key/abc', KeyState: 'Enabled' },
    });

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).rejects.toThrow(/us-east-1/);
  });

  it('refuses to start in production when the key is on its way out', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({ KeyMetadata: { Arn: KEY_ID, KeyState: 'PendingDeletion' } });

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).rejects.toThrow(/PendingDeletion/);
  });

  it('only logs the same failure outside production', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(new NotFoundException({ $metadata: {}, message: 'not found' }));

    const { wrapper } = wrapperWith(fake);

    // Local work must not be blocked by a key that is not configured yet; the first custody
    // call fails closed regardless.
    await expect(wrapper.onModuleInit()).resolves.toBeUndefined();
  });

  it('never refuses to start over an unreachable KMS, in any environment', async () => {
    const fake = fakeClient();
    fake.send.mockRejectedValue(connectionRefused());

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).resolves.toBeUndefined();
  });

  it('stays quiet about a key that resolves where it should', async () => {
    const fake = fakeClient();
    fake.send.mockResolvedValue({ KeyMetadata: { Arn: KEY_ID, KeyState: 'Enabled' } });

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).resolves.toBeUndefined();
  });

  it('accepts a key state it does not recognise', async () => {
    // An endpoint that does not report a state is not evidence that the key is dead, and
    // refusing to start on an unfamiliar answer is how a deploy breaks for no reason.
    const fake = fakeClient();
    fake.send.mockResolvedValue({ KeyMetadata: { Arn: KEY_ID } });

    const { wrapper } = wrapperWith(fake, { nodeEnv: 'production' });

    await expect(wrapper.onModuleInit()).resolves.toBeUndefined();
  });
});
