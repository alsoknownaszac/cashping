import { Injectable, Module } from '@nestjs/common';
import { ConfigModule, type DynamicModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PrismaModule } from './prisma.module.js';
import { PrismaService } from './prisma.service.js';

/**
 * Step 7b: what the refactor has to guarantee is a *module-boundary* property,
 * not a behaviour, so these assertions exercise the Nest container rather than a
 * method.
 *
 * The thing being locked in is that a feature module can inject the client by
 * importing `PrismaModule`, and that it cannot inject it by accident - i.e. the
 * provider is exported, and it is not global. Everything below is about the
 * wiring; query behaviour belongs to the feature that runs the query.
 *
 * One Prisma 7 caveat that shaped the assertions: the client is a Proxy that does
 * not carry the subclass prototype, so `instanceof PrismaService` is `false` for
 * a real `PrismaService` instance (measured, not assumed). Identity against the
 * container's provider and the forwarded `constructor.name` are what hold, so
 * those are what is asserted.
 *
 * `PrismaService`'s constructor builds a driver adapter from the connection
 * string but does not connect, so no database is needed here. `ConfigService` is
 * real and loaded through `ConfigModule`, not stubbed: `PrismaService` is
 * instantiated *inside* `PrismaModule`, so it only sees config that is global -
 * which is how Step 4 wires `ConfigModule` in `app.module.ts`. A stub registered
 * on the test's root module would sit outside `PrismaModule` and prove nothing.
 */

const DATABASE_URL = 'postgresql://cashping:cashping@localhost:5432/cashping';

/**
 * The same shape `configuration()` produces, so the key the client asks for
 * (`database.url`) is the real one. Only that key is loaded - the full validated
 * environment is `config/validation.schema.spec.ts`'s subject.
 */
function importConfig(): DynamicModule {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [() => ({ database: { url: DATABASE_URL } })],
  });
}

/** Stands in for the first real consumer - `IdentityModule` in Steps 8-16. */
@Injectable()
class ConsumerService {
  constructor(readonly prisma: PrismaService) {}
}

@Module({ imports: [PrismaModule], providers: [ConsumerService] })
class ConsumerModule {}

/** The same consumer, but its module never imported `PrismaModule`. */
@Module({ providers: [ConsumerService] })
class UnwiredModule {}

describe('PrismaModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('hands the Prisma client to a module that imports it', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), ConsumerModule],
    }).compile();

    const consumer = moduleRef.get(ConsumerService);

    expect(consumer.prisma).toBeDefined();
    expect(consumer.prisma.constructor.name).toBe('PrismaService');
    expect(typeof consumer.prisma.user.findFirst).toBe('function');
  });

  it('gives every consumer the same client instance', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [importConfig(), ConsumerModule],
    }).compile();

    expect(moduleRef.get(ConsumerService).prisma).toBe(
      moduleRef.get(PrismaService),
    );
  });

  it('is not global: injecting the client without importing it fails loudly', async () => {
    // A `@Global()` module would let this compile and hide the dependency. The
    // refactor's point is that the module graph records who talks to the
    // database, so the missing import has to be an error - and one that names
    // the unresolved provider, not a runtime `undefined` on the first query.
    await expect(
      Test.createTestingModule({ imports: [UnwiredModule] }).compile(),
    ).rejects.toThrow(/PrismaService/);
  });
});
