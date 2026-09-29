import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from './jwt/access-token.js';
import { JwtStrategy } from './jwt/jwt.strategy.js';
import { OtpRateLimiterService } from './otp/otp-rate-limiter.service.js';
import { OtpService } from './otp/otp.service.js';
import { TokenService } from './token/token.service.js';

/** Seconds in a minute, for turning the configured token lifetime into `expiresIn`. */
const SECONDS_PER_MINUTE = 60;

/**
 * Identity bounded context (Steps 8-16: the `User` model, phone normalization,
 * registration, OTP verification and sessions).
 *
 * The imports are the whole dependency story of this feature, and each one is
 * deliberate:
 *   - `PrismaModule` - the users, OTP and refresh-token rows;
 *   - `RedisModule` - the per-number request counter (Step 13);
 *   - `NotificationsModule` - the SMS that carries the code (Step 11);
 *   - `JwtModule` - the signing secret and the access-token lifetime (Step 16);
 *   - `WalletModule` - provisioning, and only provisioning (Step 19): `verifyOtp` is the
 *     event the build sequence names as the trigger ("triggered once `phoneVerifiedAt` is
 *     set"), so this module imports the wallet module's *one* exported provider rather
 *     than the module's internals. `WalletModule` exports nothing else, deliberately: key
 *     custody and Horizon are not this module's business, and an identity service holding
 *     a `StellarService` would be a second place that decides how a transaction is built.
 *     The dependency runs one way - identity asks for a wallet, the wallet knows nothing
 *     about users' sessions - and `WalletModule` does not import this one.
 *
 * There is no separate token or session module, and that is a decision rather than
 * an omission: `TokenService` and `JwtStrategy` are two halves of one agreement -
 * this API signs a token, this API verifies it - and they have to be configured
 * together or not at all. A `TokenModule` would hold the same `JwtModule.registerAsync`
 * and export the same two providers, with one more file to read to see that.
 *
 * Nothing is exported yet, and that is a real state of the world: no other module
 * consumes identity for now. The account-suspension follow-up is the change that needs
 * `TokenService` from outside - *that* is the change that adds the export, because an
 * export nothing imports is a guess about the future. (`WalletModule`'s export is the
 * other half of this rule: it arrived when this module became its consumer, not before.)
 *
 * `ConfigService` is not imported here because `ConfigModule` is global
 * (`app.module.ts`), which is the one thing that should be.
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    NotificationsModule,
    WalletModule,
    /**
     * The secret *and* the signing options, registered once so that signing and
     * verifying cannot disagree: `JwtStrategy` reads the same three constants and the
     * same secret. `registerAsync` rather than `register` because the secret comes
     * from `ConfigService`, which only has a value once `ConfigModule` has loaded
     * `.env`.
     */
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtSecret'),
        signOptions: {
          /**
           * A number of seconds rather than a string like `'15m'`: the lifetime is one
           * config key (`auth.accessTokenTtlMinutes`), and a duration string here would
           * be a second spelling of the same rule that a change to the config would
           * have to find. `TokenService.accessExpiry` computes the same instant for the
           * response body out of the same key, and `token.service.spec.ts` decodes a
           * real token to prove the two agree.
           */
          expiresIn: config.getOrThrow<number>('auth.accessTokenTtlMinutes') * SECONDS_PER_MINUTE,
          algorithm: ACCESS_TOKEN_ALGORITHM,
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, OtpRateLimiterService, TokenService, JwtStrategy],
})
export class IdentityModule {}
