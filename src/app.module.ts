import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import configuration from './config/configuration.js';
import { validate } from './config/validation.schema.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    // Step 4: loads .env, then validates it against the class-validator schema.
    // A missing or malformed required variable throws here and aborts bootstrap.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate,
    }),
    // Liveness endpoint the frontend can poll (side addition: frontend hand-off).
    HealthModule,
    // Step 7b: the Prisma client now has an owner. Imported here so `main.ts`
    // can still reach it for the boot-time reachability check; feature modules
    // import it themselves rather than receiving it through this module.
    PrismaModule,
    IdentityModule,
    WalletModule,
    PaymentsModule,
    NotificationsModule,
    LedgerModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Step 6: one global filter - shapes every error response and reports
    // unexpected failures to Sentry.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
