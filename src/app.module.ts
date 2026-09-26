import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import configuration from './config/configuration.js';
import { validate } from './config/validation.schema.js';
import { IdentityModule } from './identity/identity.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { PrismaService } from './prisma/prisma.service.js';

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
    IdentityModule,
    WalletModule,
    PaymentsModule,
    NotificationsModule,
    LedgerModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Step 5: the Prisma client. The Step 2 tree puts it in `src/prisma/` as a
    // service only, so it is provided here; once the identity module starts
    // injecting it (Day 1), it moves behind a module of its own rather than
    // being reached across the graph.
    PrismaService,
    // Step 6: one global filter - shapes every error response and reports
    // unexpected failures to Sentry.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}



