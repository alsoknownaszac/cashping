import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OtpRateLimiterService } from './otp/otp-rate-limiter.service.js';
import { OtpService } from './otp/otp.service.js';

/**
 * Identity bounded context (Steps 8-14: the `User` model, phone normalization,
 * registration and OTP verification).
 *
 * The three imports are the whole dependency story of this feature, and each one
 * is deliberate:
 *   - `PrismaModule` - the users and OTP rows;
 *   - `RedisModule` - the per-number request counter (Step 13);
 *   - `NotificationsModule` - the SMS that carries the code (Step 11).
 *
 * Nothing is exported yet, and that is a real state of the world: no other module
 * consumes identity for now. Day 2's wallet provisioning will import this module
 * (to act on `phoneVerifiedAt`), and *that* is the change that adds the export -
 * an export nothing imports is a guess about the future.
 *
 * `ConfigService` is not imported here because `ConfigModule` is global
 * (`app.module.ts`), which is the one thing that should be.
 */
@Module({
  imports: [PrismaModule, RedisModule, NotificationsModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService, OtpRateLimiterService],
})
export class IdentityModule {}
