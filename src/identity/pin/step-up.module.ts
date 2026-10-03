import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../../audit/audit.module.js';
import { StepUpAuthGuard } from '../../common/guards/step-up-auth.guard.js';
import {
  STEP_UP_TOKEN_ALGORITHM,
  STEP_UP_TOKEN_AUDIENCE,
  STEP_UP_TOKEN_ISSUER,
} from './step-up-token.js';
import { StepUpTokenService } from './step-up-token.service.js';

/** Seconds in a minute, for turning the configured lifetime into `expiresIn`. */
const SECONDS_PER_MINUTE = 60;

/**
 * The second factor, as a small module that both sides of it can import (Step 34a).
 *
 * ## Why this is a module, and why it is not `IdentityModule`
 *
 * The two ends of a step-up token live in different bounded contexts: it is *minted* where
 * the PIN is proved (`AuthService`, in identity) and *verified* by a guard in front of
 * payments. The straightforward wiring - export the guard and the token service from
 * `IdentityModule` - was rejected for the reason `PaymentsModule`'s docstring records:
 * payments deliberately does not import identity, because the boundary there is the whole
 * point of the split (identity proves who someone is; payments decides who may be paid, and
 * a module edge between them invites the second question to be answered in the first
 * module).
 *
 * So the shared thing gets a module of its own. It imports `AuditModule` (the guard writes
 * the `denied` row) and nothing else of this application, which is what makes it safe for
 * both sides to import: there is no cycle to create when a module has no consumers.
 *
 * ## Why it registers `JwtModule` again instead of borrowing identity's
 *
 * Because the audience *is* the security boundary between the two tokens. `IdentityModule`
 * registers `JwtModule` with audience `cashping-api`, for access tokens; this one registers
 * it with audience `cashping-step-up`. Signing and verifying each go through the
 * registration that matches the token they are about, so a step-up token can never be
 * presented as an access token (`JwtStrategy` would refuse the audience) and an access
 * token can never authorise a payment (`StepUpTokenService.verify` names this audience
 * explicitly). One shared secret, two contracts, and the split is what keeps them apart
 * rather than what blurs them.
 *
 * ## What is exported, and to whom
 *
 * Both providers, because both sides need one and nothing needs both: `IdentityModule`
 * injects `StepUpTokenService` to mint, `PaymentsModule` uses `StepUpAuthGuard` on the
 * route that moves money. The guard is provided here rather than in `common/`'s consumer
 * for the same reason `IdempotencyInterceptor` is provided by `PaymentsModule`: a provider
 * belongs to the module that uses it, and the guard's dependencies (the token service, the
 * audit log) are this module's.
 */
@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtSecret'),
        signOptions: {
          /**
           * A number of seconds rather than a string like `'5m'`, matching
           * `IdentityModule`: the lifetime is one config key
           * (`pin.stepUpTokenTtlMinutes`), and a duration string here would be a second
           * spelling of the same rule that a change to the config would have to find.
           */
          expiresIn: config.getOrThrow<number>('pin.stepUpTokenTtlMinutes') * SECONDS_PER_MINUTE,
          algorithm: STEP_UP_TOKEN_ALGORITHM,
          issuer: STEP_UP_TOKEN_ISSUER,
          audience: STEP_UP_TOKEN_AUDIENCE,
        },
      }),
    }),
  ],
  providers: [StepUpTokenService, StepUpAuthGuard],
  exports: [StepUpTokenService, StepUpAuthGuard],
})
export class StepUpModule {}
