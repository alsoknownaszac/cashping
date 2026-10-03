import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module.js';
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
import { EmailService } from './email/email.service.js';
import { OtpRateLimiterService } from './otp/otp-rate-limiter.service.js';
import { OtpService } from './otp/otp.service.js';
import { PasswordService } from './password/password.service.js';
import { PinService } from './pin/pin.service.js';
import { StepUpModule } from './pin/step-up.module.js';
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
 *   - `AuditModule` - the audit trail (Step 32), and the one import here that is not about
 *     serving a request. Three of the vocabulary's eight entries are written from this
 *     module (`auth.otp.verified`, `auth.login`, `user.handle.set`) because this is where an
 *     account is created, proved and signed into; the module owns the table, so there is
 *     nothing to configure on this side. Step 34a adds four more (`auth.pin.*`), which is
 *     what makes this module the majority writer of the table.
 *   - `StepUpModule` - the transaction PIN's step-up token (Step 34a). This module *mints*
 *     one from `AuthService.verifyPin`; `PaymentsModule` imports the same module to verify
 *     one. See the note in the `imports` array for why the shared thing is a module of its
 *     own rather than an export of this one.
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
 * Step 34a did not change this, and the way it avoided changing it is worth noting: the one
 * thing payments needs from this context - proof that a PIN was given - travels as
 * `StepUpModule`, a leaf module both sides import, so no boundary had to be crossed and
 * nothing had to be exported "for later".
 *
 * `ConfigService` is not imported here because `ConfigModule` is global
 * (`app.module.ts`), which is the one thing that should be.
 */
@Module({
  imports: [
    /**
     * The audit trail (Step 32). Listed first because it is the module's only cross-cutting
     * dependency - nothing on this side configures it, and it imports nothing back.
     */
    AuditModule,
    PrismaModule,
    RedisModule,
    NotificationsModule,
    WalletModule,
    /**
     * The second factor (Step 34a): the transaction PIN's step-up token, and the guard that
     * accepts it.
     *
     * A module of its own rather than more providers here, because the token has a *second*
     * consumer outside this context: `PaymentsModule` imports the same module to put
     * `StepUpAuthGuard` in front of `POST /v1/payments`. The alternative - exporting the
     * guard and the token service from this module - would have made payments import
     * identity, which its docstring records as the boundary the module graph exists to keep.
     * This side imports it to *mint*; that side imports it to *verify*; neither imports the
     * other.
     *
     * `PinService` below is *not* in there. It is this context's own service - it reads the
     * user row, owns the attempt counter and the lockout, and nothing outside identity has
     * any business calling it.
     */
    StepUpModule,
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
  providers: [
    AuthService,
    OtpService,
    OtpRateLimiterService,
    PinService,
    /**
     * The password (Step 34b) and the email address (Step 34c). Both belong to this context's
     * own services rather than to `StepUpModule`: neither is a credential that travels outside
     * identity - `PasswordService` reads the user row, and `EmailService` owns an address on it -
     * so nothing outside identity has any business calling either.
     */
    PasswordService,
    EmailService,
    TokenService,
    JwtStrategy,
  ],
})
export class IdentityModule {}
