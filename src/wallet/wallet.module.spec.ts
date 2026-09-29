import { ConfigModule } from '@nestjs/config';
import { Injectable, Module } from '@nestjs/common';
import { KMSClient } from '@aws-sdk/client-kms';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { StellarNetwork } from '../config/validation.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KEY_WRAPPER } from './custody/key-wrapper.js';
import { KMS_CLIENT_FACTORY, KmsKeyWrapper, createKmsClient } from './custody/kms-key-wrapper.js';
import { SeedCustodyService } from './custody/seed-custody.service.js';
import { ACCOUNT_FUNDER, type AccountFunder } from './provisioning/account-funder.js';
import { AccountProvisioningService } from './provisioning/account-provisioning.service.js';
import { FriendbotFunder } from './provisioning/friendbot-funder.js';
import { UsdcTrustlineService } from './provisioning/usdc-trustline.js';
import { STELLAR_ACCOUNT_SOURCE, type StellarAccountSource } from './stellar/account-source.js';
import {
  HORIZON_SERVER_FACTORY,
  HorizonAccountSource,
  createHorizonServer,
} from './stellar/horizon-account-source.js';
import { HorizonTransactionSubmitter } from './stellar/horizon-transaction-submitter.js';
import { StellarService } from './stellar/stellar.service.js';
import { STELLAR_TRANSACTION_SUBMITTER } from './stellar/transaction-submitter.js';
import { WalletModule } from './wallet.module.js';
import { BalancesService } from './balances/balances.service.js';
import { WalletController } from './wallet.controller.js';

/**
 * Step 17's other half: the wrapper has to be reachable from the module graph, and
 * the two swap points have to be bound to the real implementations in production
 * (a fake that only exists in a spec must never be what the app boots with).
 *
 * Step 18 extends the same reasoning to key custody: `KEY_WRAPPER` must be the
 * KMS-backed implementation and `KMS_CLIENT_FACTORY` the SDK constructor, while
 * *nothing* may reach AWS merely because the module was instantiated.
 *
 * Step 19 adds two more swap points (`STELLAR_TRANSACTION_SUBMITTER`, `ACCOUNT_FUNDER`)
 * and two concrete services, so it is also where the module stopped being purely
 * network-facing: `AccountProvisioningService` injects `PrismaService`, which means this
 * file has to configure `database.url` even though no query is ever run - the client
 * builds its driver adapter at construction and connects on first use, exactly as
 * `prisma.module.spec.ts` relies on. The consumer module at the bottom is the other half
 * of that: the export `IdentityModule` injects through.
 *
 * `ConfigService` is real, loaded through `ConfigModule` rather than stubbed, for
 * the same reason `PrismaModule`'s spec does it: `StellarService`,
 * `HorizonAccountSource` and `PrismaService` are instantiated *inside* `WalletModule`,
 * so a stub on the test's root module would sit outside the module under test and prove
 * nothing. The same applies to `KmsKeyWrapper`, which reads its region, credentials and
 * key reference from config at construction - and to Step 19's three, which read the
 * funder URL, the USDC issuer and the provisioning ceiling the same way.
 *
 * Step 20 adds the module's first `controllers` entry, so the assertions below also cover a
 * controller: it is instantiated with the module, and a provider missing behind it is a boot
 * failure rather than a 500 on the first request. `strict: false` is how a controller is
 * fetched from a compiled module (it is not a provider), and the endpoints themselves are
 * exercised over HTTP in `test/wallet.e2e-spec.ts`.
 */

const KMS_KEY_ARN = 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';

/** Circle's Testnet USDC issuer, the value `.env.example` ships. Never contacted here. */
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** A real connection string that is never dialled: see the docstring above. */
const DATABASE_URL = 'postgresql://cashping:cashping@localhost:5432/cashping';

const FRIENDBOT_URL = 'https://friendbot.stellar.org/';
const PROVISIONING_TIMEOUT_MS = 30_000;

/**
 * The shape of the one consumer Step 19 has: `AuthService` in `IdentityModule`, which
 * injects `AccountProvisioningService` and nothing else from this module.
 */
@Injectable()
class ProvisioningConsumer {
  constructor(readonly provisioning: AccountProvisioningService) {}
}

@Module({ imports: [WalletModule], providers: [ProvisioningConsumer] })
class ConsumerModule {}

function importConfig(): ReturnType<typeof ConfigModule.forRoot> {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [
      () => ({
        nodeEnv: 'test',
        database: {
          url: DATABASE_URL,
        },
        stellar: {
          network: 'TESTNET',
          horizonUrl: 'https://horizon-testnet.stellar.org',
          fallbackHorizonUrl: 'http://localhost:8000',
          /** Step 19's three, each read once by the provider that owns it. */
          usdcIssuer: USDC_ISSUER,
          friendbotUrl: FRIENDBOT_URL,
          provisioningTimeoutMs: PROVISIONING_TIMEOUT_MS,
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
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    expect(moduleRef.get(KEY_WRAPPER)).toBeInstanceOf(KmsKeyWrapper);
    expect(moduleRef.get(SeedCustodyService)).toBeInstanceOf(SeedCustodyService);
  });

  it('binds the KMS client factory to the SDK constructor', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

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

  it('binds the submitter token to the Horizon-backed implementation', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    // The same reasoning as `STELLAR_ACCOUNT_SOURCE`, one step further along the same
    // transaction: the token exists so `StellarService`'s specs can hang a fake on it, and
    // production must be bound to the class that actually posts to Horizon - otherwise every
    // trustline this app ever submits is signed and then dropped on the floor.
    expect(moduleRef.get(STELLAR_TRANSACTION_SUBMITTER)).toBeInstanceOf(
      HorizonTransactionSubmitter,
    );
  });

  it('binds the funder token to friendbot rather than to a spec double', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    const funder = moduleRef.get<AccountFunder>(ACCOUNT_FUNDER);

    // Who funds an account is a deployment decision, and `kind` is how the provisioning log
    // says which one it was ("via friendbot"), so a Testnet build shipping something else -
    // a fake, or (the mistake this guards) a treasury stub from a spec - would be visible in
    // the log as a lie rather than in a stack trace later.
    expect(funder).toBeInstanceOf(FriendbotFunder);
    expect(funder.kind).toBe('friendbot');
  });

  it('resolves provisioning and every dependency it injects', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    // The regression this locks in: `AccountProvisioningService` takes `PrismaService` as its
    // first parameter, and a provider is only visible to the module that *imports* it - so
    // the step that added this service to `providers` also had to add `PrismaModule` to
    // `imports`, which `WalletModule` had never needed before. Without it the failure is
    // total and it is not in provisioning: Nest cannot build the service, so the app cannot
    // boot. This assertion is where that is caught, in a unit test, rather than at delivery.
    expect(moduleRef.get(AccountProvisioningService)).toBeInstanceOf(AccountProvisioningService);
    expect(moduleRef.get(UsdcTrustlineService)).toBeInstanceOf(UsdcTrustlineService);
    expect(moduleRef.get(PrismaService)).toBeDefined();
  });

  it('registers the wallet controller with everything it injects (step 20)', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule],
    }).compile();

    /**
     * A controller is instantiated with the module that declares it, so a provider missing
     * behind `GET /v1/wallet/*` is a boot failure rather than a 500 on the first request -
     * and `BalancesService` injects `PrismaService`, `StellarService` and
     * `UsdcTrustlineService`, which means this also asserts that the step-19 services are
     * still reachable from inside the module after the step-20 additions.
     *
     * `strict: false` because a controller is not a provider: it is reachable through the
     * module (`_controllers`), not through the injector's provider list, and asking for it
     * strictly is how this test would fail for the wrong reason.
     */
    expect(moduleRef.get(WalletController, { strict: false })).toBeInstanceOf(WalletController);
    expect(moduleRef.get(BalancesService)).toBeInstanceOf(BalancesService);
  });

  it('exports provisioning, which is the only provider an outside module may inject', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), WalletModule, ConsumerModule],
    }).compile();

    // The export list *is* this module's boundary, and `IdentityModule`'s docstring records
    // the rule from the other side. The consumer below is the shape of Step 19's one
    // customer - a service that can ask for a wallet and cannot reach custody, Horizon or
    // the funder - and it receives the module's own instance, not a second one.
    expect(moduleRef.get(ProvisioningConsumer).provisioning).toBe(
      moduleRef.get(AccountProvisioningService),
    );
  });

  it('reaches no Horizon, no AWS and no faucet at boot', async () => {
    const horizonFactory = vi.fn(createHorizonServer);
    const kmsFactory = vi.fn(
      () =>
        ({
          send: vi.fn(async () => ({ KeyMetadata: { Arn: KMS_KEY_ARN, KeyState: 'Enabled' } })),
        }) as unknown as KMSClient,
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    moduleRef = await Test.createTestingModule({ imports: [importConfig(), WalletModule] })
      .overrideProvider(HORIZON_SERVER_FACTORY)
      .useValue(horizonFactory)
      .overrideProvider(KMS_CLIENT_FACTORY)
      .useValue(kmsFactory)
      .compile();

    await moduleRef.init();

    // Boot is the one moment this app must not depend on someone else's uptime, and Step 19
    // added two new ways to break that: a funder whose only job is an HTTP POST, and a
    // submitter that builds its Horizon client on first use. Both are lazy, so the module
    // starts with a faucet that is down and a Horizon that is unreachable - and the only
    // outbound call at startup is the KMS client the probe above builds, once.
    expect(horizonFactory).not.toHaveBeenCalled();
    expect(kmsFactory).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
