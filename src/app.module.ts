import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import configuration from './config/configuration.js';
import { validate } from './config/validation.schema.js';
import { IdentityModule } from './identity/identity.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { LedgerModule } from './ledger/ledger.module.js';

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
  providers: [AppService],
})
export class AppModule {}


