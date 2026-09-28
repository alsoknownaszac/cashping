import { ConfigModule } from '@nestjs/config';
import { KMSClient } from '@aws-sdk/client-kms';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { StellarNetwork } from '../config/validation.schema.js';
import { KEY_WRAPPER } from './custody/key-wrapper.js';
import { KMS_CLIENT_FACTORY, KmsKeyWrapper, createKmsClient } from './custody/kms-key-wrapper.js';
import { SeedCustodyService } from './custody/seed-custody.service.js';
import { STELLAR_ACCOUNT_SOURCE, type StellarAccountSource } from './stellar/account-source.js';
import {
  HORIZON_SERVER_FACTORY,
  HorizonAccountSource,
  createHorizonServer,
} from './stellar/horizon-account-source.js';
import { StellarService } from './stellar/stellar.service.js';
import { WalletModule } from './wallet.module.js';

/**
 * Step 17's other half: the wrapper has to be reachable from the module graph, and
 * the two swap points have to be bound to the real implementations in production
 * (a fake that only exists in a spec must never be what the app boots with).
 *
 * Step 18 extends the same reasoning to key custody: `KEY_WRAPPER` must be the
 * KMS-backed implementation and `KMS_CLIENT_FACTORY` the SDK constructor, while
 * *nothing* may reach AWS merely because the module was instantiated.
 *
 * `ConfigService` is real, loaded through `ConfigModule` rather than stubbed, for
 * the same reason `PrismaModule`'s spec does it: `StellarService` and
 * `HorizonAccountSource` are instantiated *inside* `WalletModule`, so a stub on the
 * test's root module would sit outside the module under test and prove nothing. The
 * same applies to `KmsKeyWrapper`, which reads its region, credentials and key
 * reference from config at construction.
 */

const KMS_KEY_ARN = 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';

function importConfig(): ReturnType<typeof ConfigModule.forRoot> {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [
      () => ({
        nodeEnv: 'test',
        stellar: {
          network: 'TESTNET',
          horizonUrl: 'https://horizon-testnet.stellar.org',
          fallbackHorizonUrl: 'http://localhost:8000',
        },
        aws: {
          region: 'eu-west-1',
          endpointUrl: undefined,
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'test-fixture-secret',
          kmsKeyId: KMS_KEY_ARN,
        },
      }),
    ],
  });
}

describe('WalletModule', () => {
  let moduleRef: TestingModule | undefined;

  it('instantiates the Stellar wrapper from the global config alone', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    const service = moduleRef.get(StellarService);

    expect(service.network()).toBe(StellarNetwork.Testnet);
    expect(service.horizonUrl()).toBe('https://horizon-testnet.stellar.org');
  });

  it('binds the account-source token to the Horizon-backed implementation', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    expect(moduleRef.get(STELLAR_ACCOUNT_SOURCE)).toBeInstanceOf(HorizonAccountSource);
    expect(moduleRef.get(StellarService)).toBeDefined();
  });

  it('binds the Horizon client factory to the SDK constructor', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    // Deriving the type from `Horizon.Server` is what keeps this honest: if the
    // binding were a stub, the type would not line up and the app would build
    // transactions no real Horizon ever sees.
    expect(moduleRef.get(HORIZON_SERVER_FACTORY)).toBe(createHorizonServer);
  });

  it('does not open a Horizon client just because the module was instantiated', async () => {
    const factory = vi.fn(createHorizonServer);

    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] })
      .overrideProvider(HORIZON_SERVER_FACTORY)
      .useValue(factory)
      .compile();

    // Boot must not depend on a public network: the client is created on the first
    // account load, so a Horizon outage cannot stop the API from starting.
    expect(factory).not.toHaveBeenCalled();
    expect(moduleRef.get<StellarAccountSource | unknown>(HORIZON_SERVER_FACTORY)).toBe(factory);
  });

  it('binds the key-wrapper token to the KMS-backed implementation', async () => {
    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] }).compile();

    expect(moduleRef.get(KEY_WRAPPER)).toBeInstanceOf(KmsKeyWrapper);
    expect(moduleRef.get(SeedCustodyService)).toBeInstanceOf(SeedCustodyService);
  });

  it('binds the KMS client factory to the SDK constructor', async () => {
    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] }).compile();

    // The same reasoning as `HORIZON_SERVER_FACTORY`: if this binding were a stub, seeds
    // would be wrapped by something that is not KMS, and the type would not line up.
    expect(moduleRef.get(KMS_CLIENT_FACTORY)).toBe(createKmsClient);
  });

  it('does not reach for KMS just because the module was instantiated', async () => {
    const factory = vi.fn(() => ({ send: vi.fn() }) as unknown as KMSClient);

    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] })
      .overrideProvider(KMS_CLIENT_FACTORY)
      .useValue(factory)
      .compile();

    // Compiling the module graph - which every spec that imports `WalletModule` does - must
    // build no client, or the unit suite would need AWS.
    expect(factory).not.toHaveBeenCalled();
  });

  it('probes the configured key once at startup, through the injected client', async () => {
    const send = vi.fn(async () => ({ KeyMetadata: { Arn: KMS_KEY_ARN, KeyState: 'Enabled' } }));
    const factory = vi.fn(() => ({ send }) as unknown as KMSClient);

    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] })
      .overrideProvider(KMS_CLIENT_FACTORY)
      .useValue(factory)
      .compile();

    await moduleRef.init();

    // One `DescribeKey` at boot: that is what turns a key reference that does not resolve, or
    // a key in another region, into a single startup line instead of a failure per account
    // later - the mistake the Step 18 spike took a detour to diagnose.
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as unknown as [{ constructor: { name: string } }];

    expect(command.constructor.name).toBe('DescribeKeyCommand');
  });
});
