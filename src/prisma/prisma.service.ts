import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma client wrapper (Step 5).
 *
 * Prisma 7 no longer speaks the wire protocol from the generated client: it
 * needs a driver adapter, so the connection string is handed to `PrismaPg`
 * (node-postgres) instead of living in `schema.prisma`.
 *
 * The string comes from `ConfigService` - the same validated, Step 4-owned
 * source every other component reads - so it cannot drift from what the
 * validation schema approved, and `getOrThrow` fails loudly rather than
 * connecting to `undefined`.
 *
 * The client connects lazily on the first query, which the boot-time
 * reachability check in `main.ts` performs. `onModuleDestroy` closes the pool on
 * SIGTERM/SIGINT (`app.enableShutdownHooks()`), which is what a `docker stop`
 * relies on.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('database.url'),
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma client disconnected');
  }
}
