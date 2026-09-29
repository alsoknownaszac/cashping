import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  KmsKeyNotFoundError,
  KeyCustodyUnavailableError,
} from './../src/wallet/custody/key-wrapper.js';
import { KmsKeyWrapper, createKmsClient } from './../src/wallet/custody/kms-key-wrapper.js';
import { SecretEnvelopeError } from './../src/wallet/custody/secret-envelope.js';
import {
  SeedCustodyService,
  type SealedAccount,
} from './../src/wallet/custody/seed-custody.service.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Step 18 against a **real** KMS endpoint (Step 18's opt-in half).
 *
 * Everything else about custody is covered offline, with the AWS client faked. This file
 * exists for the four things a fake cannot answer: that the request shapes are accepted by
 * KMS itself, that a data key really comes back, that `EncryptionContext` really binds (a
 * blob presented under another account is refused *by KMS*), and that an unreachable
 * endpoint really arrives as an outage rather than as corruption.
 *
 * It is skipped unless `RUN_KMS_IT` is set, so neither CI nor a normal `npm test` needs an
 * endpoint or credentials - this is the one place in the suite that talks to a socket, and
 * it needs a key that exists.
 *
 * ```bash
 * # LocalStack (KMS on 4566; a licence token is required, and it takes ~2.5 min to come up)
 * docker run -d --name cashping-kms -p 4566:4566 -e SERVICES=kms \
 *   -e LOCALSTACK_AUTH_TOKEN=... localstack/localstack:latest
 * # a master key *in that emulator*, then its ARN
 * awslocal kms create-key --description cashping-seeds
 * AWS_KMS_KEY_ID=<that arn> AWS_ENDPOINT_URL=http://localhost:4566 RUN_KMS_IT=1 npm run test:e2e
 * ```
 *
 * Nothing here touches Postgres or Redis, and nothing is persisted: this spec is about key
 * custody, so it wires `KmsKeyWrapper` and `SeedCustodyService` the way `WalletModule` does
 * and stops there. Step 19 is what writes rows.
 */
const ENABLED = process.env['RUN_KMS_IT'] === '1';
const REGION = process.env['AWS_REGION'] ?? 'eu-west-1';

/** The app's config, read from this process's environment rather than from a `.env`. */
function configWith(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    'aws.region': REGION,
    'aws.endpointUrl': process.env['AWS_ENDPOINT_URL'],
    'aws.accessKeyId': process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    'aws.secretAccessKey': process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    'aws.kmsKeyId': process.env['AWS_KMS_KEY_ID'],
    nodeEnv: 'test',
    'stellar.network': 'TESTNET',
    'stellar.horizonUrl': 'https://horizon-testnet.stellar.org',
    'stellar.fallbackHorizonUrl': 'http://localhost:8000',
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`missing ${key} - see this file's header for what to export`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

/** The real wrapper, wired exactly as `WalletModule` wires it. */
function wrapperWith(overrides: Record<string, string | undefined> = {}): KmsKeyWrapper {
  return new KmsKeyWrapper(configWith(overrides), createKmsClient);
}

/** The real service. `StellarService` is real too, with two ports it never reaches. */
function serviceWith(overrides: Record<string, string | undefined> = {}): SeedCustodyService {
  const stellar = new StellarService(
    configWith(overrides),
    {
      loadAccount: () => {
        throw new Error('custody never loads an account: this spec has no Horizon');
      },
    },
    {
      /**
       * Step 19 gave `StellarService` a second port - somewhere to send a signed
       * transaction - and it is filled in for the same reason the account source is:
       * the service under test needs a real `StellarService`, and this spec is about
       * key material, so neither Horizon nor a funder is involved. A call to either
       * is a failure of the spec, not a request to make.
       */
      submit: () => {
        throw new Error('custody never submits a transaction: this spec has no Horizon');
      },
    },
  );

  return new SeedCustodyService(wrapperWith(overrides), stellar);
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

/** The wrapped-data-key segment of an envelope, as bytes. */
function wrappedDataKeyOf(sealed: SealedAccount): Buffer {
  return Buffer.from(sealed.encryptedSecretKey.split('.')[1] ?? '', 'base64url');
}

describe.skipIf(!ENABLED)('key custody against a live KMS endpoint', () => {
  it('probes the configured key, which is the whole point of the probe', async () => {
    const wrapper = wrapperWith();

    // Would throw here if the key reference did not resolve, or if the key resolved into a
    // region other than AWS_REGION - the two mistakes the probe exists to catch.
    await expect(wrapper.describeMasterKey()).resolves.toMatchObject({
      region: REGION,
      keyState: 'Enabled',
    });
  });

  it('seals a seed so that only a KMS call can open it', async () => {
    const service = serviceWith();
    const sealed = await service.createSealedAccount();

    expect(sealed.encryptedSecretKey.startsWith('cp-kms-1.')).toBe(true);
    expect(sealed.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    // The stored blob is not a secret, in any spelling.
    expect(sealed.encryptedSecretKey).not.toMatch(/S[A-Z2-7]{55}/);

    const opened = await service.openSeed(rowOf(sealed));

    expect(opened.publicKey()).toBe(sealed.publicKey);
    expect(opened.secret()).toMatch(/^S[A-Z2-7]{55}$/);
  });

  it('gives three accounts three different data keys', async () => {
    const service = serviceWith();
    const sealed = [
      await service.createSealedAccount(),
      await service.createSealedAccount(),
      await service.createSealedAccount(),
    ];

    // The audit's requirement, and the reason it is checked on the *wrapped* segment rather
    // than on the whole blob: a shared data key under three fresh IVs would still produce
    // three different blobs.
    expect(new Set(sealed.map((account) => account.accountId)).size).toBe(3);
    expect(new Set(sealed.map((account) => account.encryptedSecretKey)).size).toBe(3);
    expect(
      new Set(sealed.map((account) => wrappedDataKeyOf(account).toString('base64url'))).size,
    ).toBe(3);

    // Each row records the key that actually wrapped it, as a resolved ARN.
    for (const account of sealed) {
      expect(account.dataKeyArn).toMatch(new RegExp(`^arn:aws[k-z-]*:kms:${REGION}:\\d{12}:key/`));
    }
  });

  it('is refused by KMS itself when a blob is presented under another account', async () => {
    const wrapper = wrapperWith();
    const first = await wrapper.wrapDataKey({ accountId: randomUUID() });
    const otherAccount = randomUUID();

    // The service cannot reach this state by construction - it always passes the row's own id
    // - so the binding is exercised directly, which is the point: this is what KMS answers
    // when the encryption context does not match the one used to wrap. The blob is genuine,
    // the key is genuine, only the account differs.
    const failed = await wrapper
      .unwrapDataKey({
        accountId: otherAccount,
        keyArn: first.keyArn,
        wrappedDataKey: first.wrappedDataKey,
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SecretEnvelopeError);
    expect((failed as SecretEnvelopeError).reason).toBe('key-mismatch');
  });

  it('reports a key reference that does not resolve as configuration, never as corruption', async () => {
    // A well-formed ARN for a key that cannot exist, so this is deterministic.
    const missing = `arn:aws:kms:${REGION}:000000000000:key/${randomUUID()}`;
    const service = serviceWith({ 'aws.kmsKeyId': missing });

    const failed = await service.createSealedAccount().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KmsKeyNotFoundError);
    expect(failed).not.toBeInstanceOf(SecretEnvelopeError);
  });

  it('reports an unreachable endpoint as an outage, with the reason attached', async () => {
    // Nothing listens here. This is the failure the spike had to diagnose by hand: the SDK
    // surfaces it with no usable message, so the *code* is the only thing to report.
    const service = serviceWith({ 'aws.endpointUrl': 'http://127.0.0.1:4599' });

    const failed = await service.createSealedAccount().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(KeyCustodyUnavailableError);
    // The name in front of the code is not asserted, because it genuinely varies: a
    // single-address endpoint gives a plain `Error`, while a name that resolves to two
    // addresses (`localhost`, as in the README) is aggregated by the SDK into an
    // `AggregateError` with an empty message. Matching on the code is what covers both - see
    // `classifyKmsFailure`.
    expect((failed as KeyCustodyUnavailableError).detail).toMatch(/^[A-Za-z]+ \(ECONNREFUSED\)$/);
    expect(failed).not.toBeInstanceOf(SecretEnvelopeError);
  });

  it('keeps a signature usable end to end: open, sign, verify', async () => {
    const service = serviceWith();
    const sealed = await service.createSealedAccount();
    const signer = await service.openSeed(rowOf(sealed));

    // The real reason a seed is stored at all: it has to produce a signature that the public
    // key on the row verifies. That is the one assertion a fake KMS could never make.
    const signature = signer.sign(Buffer.from('cashping step 18', 'utf8'));

    expect(
      Keypair.fromPublicKey(sealed.publicKey).verify(
        Buffer.from('cashping step 18', 'utf8'),
        signature,
      ),
    ).toBe(true);
  });
});
