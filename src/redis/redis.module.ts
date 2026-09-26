import { Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Owns the Redis connection and nothing else (added for Step 13).
 *
 * The build sequence's file tree has no `redis/` folder, and this is why it
 * exists anyway: the OTP request limit has to count requests per phone number
 * across restarts, `@nestjs/throttler`'s default store is per-process memory
 * (which would reset on every deploy and is the wrong tool for a limit that
 * protects a paid SMS gateway), and a counter kept in Postgres would put a write
 * on the hot path of an endpoint an attacker is the one calling. Redis is the
 * counter, so the connection needs an owner.
 *
 * Deliberately *not* `@Global()`, for the same reason `PrismaModule` is not:
 * which modules depend on Redis is information worth reading off the module
 * graph.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
