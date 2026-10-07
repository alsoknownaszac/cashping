import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor.js';
import { RedisIdempotencyStore } from '../common/interceptors/idempotency-store.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { StepUpModule } from '../identity/pin/step-up.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PaymentsController } from './controllers/payments.controller.js';
import { RecipientsController } from './controllers/recipients.controller.js';
import { HandlesController } from './controllers/handles.controller.js';
import { PaymentsQueueModule } from './jobs/payments-queue.module.js';
import { PaymentsService } from './services/payments.service.js';
import { HandlesService } from './services/handles.service.js';
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
 * land in this module next, which is why nothing here moves money and why `jobs/` held nothing
 * until Step 26: a queue nothing puts anything on is a directory, not a queue.
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
 * the build sequence says to propose before implementing. What *is* imported from the wallet is
 * `BalancesService` (Step 25): a payment has to know what the sender's wallet holds, and the
 * module that owns that question answers it - see `WalletModule`'s docstring.
 *
 * Step 26 adds a fourth import, `PaymentsQueueModule`, and it is here for its *wiring* rather
 * than for anything this module calls: that module registers the payments queue, starts the
 * worker that drains it, and exports `PaymentsQueueService` - the enqueue seam Step 27 uses. It
 * is imported here and not in `AppModule` for the reason the other three are imported here: the
 * queue is a payment dependency and the module graph should say so. Nothing in this module
 * enqueues anything yet, which is the honest state of Step 26 - the plumbing is live end to end
 * (a probe job round-trips through it in `test/queue.e2e-spec.ts`), and the first job that is
 * *about* a payment belongs to the step the build sequence gates on a proposal.
 *
 * Steps 24 and 25 add the write side of this module: `PaymentsController`, `PaymentsService`,
 * and the two idempotency providers - `IdempotencyInterceptor` (Step 24's policy) and
 * `RedisIdempotencyStore` (its state). The two live in `src/common/interceptors/` because that
 * is the path the build sequence names for the interceptor and because they are not
 * payments-specific infrastructure (the submission endpoints in Steps 27-29 need the same
 * guarantee), while being *provided* here is the honest statement of who uses them today: a
 * provider in a module nothing else imports is a claim about a future consumer, and this pair
 * gets promoted to its own module the day there is a second one.
 *
 * `RecipientsService` is injected by `PaymentsService` rather than duplicated: "may this id be
 * paid" has one answer (`assertPayableRecipient`), and the payment path is the second reader of
 * it - which is why that method exists without the lookup limit (see its docstring).
 *
 * Step 32 adds `AuditModule`, and the fifth import is the whole of that step here. The entries this
 * module writes are `payment.initiated` - from `PaymentsService.create`, *after* the transaction
 * that created the row has committed and its submission been queued, because an entry written
 * inside that transaction could survive a rollback and describe a payment that does not exist - and
 * the confirmation sweep's `payment.completed` / `payment.failed`. The sweep is provided by this
 * module, so it needs no import of its own.
 *
 * Step 34a adds `StepUpModule`, and it is worth being exact about what it is not. It is *not*
 * `IdentityModule`: that boundary is the one described above, and this step did not move it. The
 * second factor is a leaf contract both contexts import - identity mints the token when the PIN is
 * proved, this module verifies it on the route that moves money - so `PaymentsController` gets the
 * guard without this module gaining an edge into the context that owns sessions. Nothing in this
 * module has learned what a PIN is, and `PaymentsService` least of all: it never sees a token, a
 * header or a credential, because `StepUpAuthGuard` is the only thing that knows, and it refuses
 * the request before the service is reached.
 *
 * The handle availability check (`HandlesController`, `HandlesService`) is the directory's third
 * reader. It answers a question a payment form asks - "is this name free for someone to be paid
 * at" - from the same `PrismaModule` users table and the same `RecipientLookupRateLimiter`
 * allowance the two recipient routes spend, and it takes its rules from `handle.ts` as a file, the
 * same edge this module already has into identity. It moves no money, which is why it sits here
 * with the other reads rather than needing anything this module does not already import.
 */
@Module({
  imports: [AuditModule, PrismaModule, RedisModule, WalletModule, PaymentsQueueModule, StepUpModule],
  controllers: [RecipientsController, HandlesController, PaymentsController],
  providers: [
    RecipientsService,
    HandlesService,
    RecipientLookupRateLimiter,
    PaymentsService,
    IdempotencyInterceptor,
    RedisIdempotencyStore,
  ],
})
export class PaymentsModule {}
