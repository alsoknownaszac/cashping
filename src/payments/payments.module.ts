import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { RecipientsController } from './controllers/recipients.controller.js';
import { RecipientLookupRateLimiter } from './services/recipient-lookup-rate-limiter.service.js';
import { RecipientsService } from './services/recipients.service.js';

/**
 * Payments bounded context (Steps 21-29).
 *
 * What is here as of Steps 21-22 is the *directory*: the two endpoints that turn what someone
 * typed into an account id (`RecipientsController`), the lookup itself
 * (`RecipientsService`, which owns what a recipient may be described by), and the per-caller
 * allowance that makes sweeping the directory cost something
 * (`RecipientLookupRateLimiter`). Payment creation (23-25) and Stellar submission (26-29)
 * land in this module next, which is why nothing here moves money and why the `jobs/`
 * directory is still empty: nothing is queued until there is something worth queuing.
 *
 * The two imports are the whole dependency story, and both are choices:
 *
 * - `PrismaModule` is where the `users` table lives. This module reads it directly rather than
 *   asking `IdentityModule` for a "find user by handle" method, and that is the module
 *   boundary working as intended: identity owns *proving who a user is*, this module owns
 *   *deciding who may be paid*, and a service call between them would still be this query
 *   written somewhere else - with the disclosure decision (which columns, which statuses)
 *   living in a module that exists for a different purpose. The `JwtAuthGuard` and
 *   `@CurrentUser` this module does reuse are imported as *files* from `src/identity/jwt`, and
 *   `IdentityModule` is deliberately not imported: see `RecipientsController`.
 * - `RedisModule` is the lookup counter. Redis, not an in-memory counter, for the reasons
 *   `OtpRateLimiterService` records: the window has to survive a restart and be shared by
 *   every API instance, or the limit is per-process decoration.
 *
 * `StellarService` (the wallet's) is not imported yet, and its absence is the boundary still
 * holding: nothing in this module signs or submits anything until Step 27, which is the step
 * the build sequence says to propose before implementing.
 */
@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [RecipientsController],
  providers: [RecipientsService, RecipientLookupRateLimiter],
})
export class PaymentsModule {}
