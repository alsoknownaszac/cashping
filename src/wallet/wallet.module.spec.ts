import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { StellarNetwork } from '../config/validation.schema.js';
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
 * `ConfigService` is real, loaded through `ConfigModule` rather than stubbed, for
 * the same reason `PrismaModule`'s spec does it: `StellarService` and
 * `HorizonAccountSource` are instantiated *inside* `WalletModule`, so a stub on the
 * test's root module would sit outside the module under test and prove nothing.
 */

function importConfig(): ReturnType<typeof ConfigModule.forRoot> {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [
      () => ({
        stellar: {
          network: 'TESTNET',
          horizonUrl: 'https://horizon-testnet.stellar.org',
          fallbackHorizonUrl: 'http://localhost:8000',
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
});
