import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Owns the Prisma client and nothing else (Step 7b - the Day 1 prerequisite).
 *
 * Until now `PrismaService` was provided by `AppModule` directly, which is fine
 * while the only consumer is `main.ts` reaching it with `app.get()`. It stops
 * being fine the moment a feature module injects it: a provider registered in a
 * module that another module does not import is invisible to that module, so the
 * identity module (Steps 8-16) would either have to register a second client -
 * a second connection pool, and two things to disconnect - or the provider would
 * have to be made global and the dependency would disappear from the graph.
 *
 * So the client lives behind this module and is exported. A feature module that
 * talks to the database adds `PrismaModule` to its `imports` and injects
 * `PrismaService` as an ordinary constructor parameter: one client, one pool, and
 * the dependency is written down in the module that uses it.
 *
 * Deliberately *not* `@Global()`: which modules talk to the database is
 * information worth keeping in the module graph.
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
