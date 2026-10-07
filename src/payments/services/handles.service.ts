import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { handleProblem, normalizeHandle } from '../../identity/handle/handle.js';
import { handleRejectionMessage } from '../../identity/handle/handle-rejection.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type HandleAvailabilityQueryDto,
  type HandleAvailabilityResponseDto,
} from '../dto/handle-availability.dto.js';
import {
  RecipientLookupRateLimitExceededError,
  RecipientLookupRateLimitUnavailableError,
  RecipientLookupRateLimiter,
} from './recipient-lookup-rate-limiter.service.js';

/**
 * The handle availability check (`GET /v1/handles/availability`): "could I claim this handle?".
 *
 * ## The same rules registration applies, from the same module
 *
 * Shape before availability, exactly as `AuthService.resolveHandle` does it, and for the same
 * reason: a handle that can never be valid is a 400 whatever the database happens to contain, and
 * answering "taken" for something like `@@adm in` would be a lie about a name that was never a
 * candidate. The rules themselves - length, characters, reserved words - are `handleProblem` from
 * `handle.ts`, and the refusal is `handleRejectionMessage`, so a handle refused here reads the
 * same as the same handle refused at registration. This service states no rule of its own; there
 * is nothing here for `handle.spec.ts` to drift from.
 *
 * ## The database is asked one question, about a unique column
 *
 * `users.handle` is unique and stored canonically, so the whole lookup is a `findUnique` on the
 * handle column - the plain index, no `mode: 'insensitive'`, for the reason `handle.ts` records.
 * The caller's id is read so the answer can be "yes" for the handle they already hold (a
 * re-submitted name is the no-op `resolveHandle` allows); a *different* account holding it is the
 * only `false`.
 *
 * ## The allowance is the directory's, and shared deliberately
 *
 * This endpoint spends `RecipientLookupRateLimiter` - the same counter, keyed the same way - and
 * that sharing is the design rather than a shortcut. It answers "does this identifier resolve to
 * an account", which is precisely the question sweeping `/recipients/search` answers one guess at
 * a time: the oracle is the same oracle, so the honest cap is the same allowance, and a caller who
 * wants more of it has to spend it here instead of there rather than on top of it. The refusal is
 * shaped like the directory's too - a 429 carrying the wait, or a 503 when Redis cannot be asked -
 * which is why the two mappings below are the ones `RecipientsService` makes.
 *
 * ## Shape is checked before the allowance is spent
 *
 * A malformed handle is refused without consuming a lookup, because it cannot enumerate anything:
 * it is rejected before any query runs, so there is no cost to price. Every *valid* handle does
 * spend a unit, miss or hit alike, which is what keeps "is this name taken" from being asked for
 * free, one name at a time.
 */
@Injectable()
export class HandlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RecipientLookupRateLimiter,
  ) {}

  /**
   * `GET /v1/handles/availability` (the handle-claim check).
   *
   * Returns the canonical handle and whether the caller could claim it. Throws a 400 naming the
   * rule for a handle that is not a handle, a 429 when the lookup allowance is spent, and a 503
   * when that allowance could not be evaluated.
   */
  async checkAvailability(
    callerId: string,
    dto: HandleAvailabilityQueryDto,
  ): Promise<HandleAvailabilityResponseDto> {
    // One reading of the input, then the rules on it: `handleProblem` normalizes internally, so it
    // is handed what the caller typed, while `normalizeHandle` names the canonical form this
    // method goes on to answer about. Shape first, availability second - see the class docstring.
    const handle = normalizeHandle(dto.handle);
    const problem = handleProblem(dto.handle);

    if (problem !== null) {
      throw new BadRequestException(handleRejectionMessage(problem, dto.handle, handle));
    }

    await this.assertWithinLookupLimit(callerId);

    const holder = await this.prisma.user.findUnique({
      where: { handle },
      select: { id: true },
    });

    // `false` only when someone *else* holds it: the caller's own handle is claimable by them, the
    // same way `resolveHandle`'s conflict check passes over a holder who is the owner.
    return { handle, available: holder === null || holder.id === callerId };
  }

  /**
   * Counts a lookup against the caller's allowance, or refuses.
   *
   * The same two mappings `RecipientsService.assertWithinLookupLimit` uses, for the same reasons:
   * over the limit is a 429 with the wait in the message (the client can show a countdown), and a
   * Redis that cannot be reached is a 503 whose detail stays in the log - never a lookup that
   * proceeds uncounted. The wording is this endpoint's own ("handle checks") while the counter and
   * its key are the directory's: the mechanism is shared, the sentence names what was asked.
   */
  private async assertWithinLookupLimit(callerId: string): Promise<void> {
    try {
      await this.rateLimiter.consume(callerId);
    } catch (error) {
      if (error instanceof RecipientLookupRateLimitExceededError) {
        const seconds = error.retryAfterSeconds;

        throw new HttpException(
          `Too many handle checks. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof RecipientLookupRateLimitUnavailableError) {
        throw new ServiceUnavailableException(
          'Handle availability is temporarily unavailable. Please try again in a moment.',
        );
      }

      throw error;
    }
  }
}
