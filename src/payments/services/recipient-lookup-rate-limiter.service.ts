import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service.js';

/**
 * The caller spent the lookup allowance for this window.
 *
 * Carries the wait, like `OtpRateLimitExceededError` does, so the response can say how long
 * rather than leaving the client to guess.
 */
export class RecipientLookupRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many recipient lookups; retry after ${retryAfterSeconds}s`);
    this.name = 'RecipientLookupRateLimitExceededError';
  }
}

/**
 * The allowance could not be evaluated - Redis is unreachable.
 *
 * A distinct error because it must *fail closed*, exactly as the OTP limiter does: a caller
 * whose counter cannot be read is a caller whose sweep cannot be counted, and "assume they are
 * fine" is the one wrong guess that hands over the directory.
 */
export class RecipientLookupRateLimitUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Could not evaluate the recipient lookup limit', options);
    this.name = 'RecipientLookupRateLimitUnavailableError';
  }
}

/**
 * Caps how many times one signed-in user may consult the recipient directory (Step 21).
 *
 * Step 21 asks for this endpoint to be rate-limited *specifically*, and the reason is in the
 * request shape: a search answers "is this number registered" and "who is called mir…", so an
 * account that can ask unlimited times can turn the directory into a membership oracle - the
 * number you probe either resolves to a person or does not, and that difference is the answer.
 * The limit is the price of asking.
 *
 * A counter in Redis rather than `@nestjs/throttler`, for the two reasons
 * `OtpRateLimiterService` records: the throttler's default store is per-process memory, so two
 * API instances would each allow the full allowance and a deploy would reset it; and the
 * window has to be shared across every instance for a limit that is about *cost*. The counter
 * is keyed by the caller rather than by IP - the caller is authenticated, so an account is the
 * unit that sweeps and rotating IPs must not buy more allowance, while a shared IP (an office,
 * a carrier NAT) must not share one.
 *
 * Fixed window, like the OTP limiter, with the same accepted worst case (`2 x` the allowance
 * across a boundary). The upgrade path if a sweep ever exploits the boundary is a sorted set
 * of timestamps per caller.
 *
 * Both directory endpoints consume this one allowance - the search and the confirmation read -
 * because both are lookups and one confirmation per search is the flow they exist for. The
 * cost of the pair being two units is real and small; the cost of the confirmation read being
 * unlimited would be a way around the search limit by other means, one guessed id at a time.
 */
@Injectable()
export class RecipientLookupRateLimiter {
  private readonly logger = new Logger(RecipientLookupRateLimiter.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Counts one lookup against the caller's allowance, throwing when it is already gone.
   *
   * The refused request still increments the counter (that is inherent to `INCR`), but it does
   * not extend the window: `EXPIRE ... NX` only sets the TTL on a new key, so a caller who
   * keeps hammering cannot hold their own window open - and, because the key belongs to the
   * caller alone, cannot hold anyone else's open either.
   */
  async consume(callerId: string): Promise<void> {
    const requestsPerWindow = this.config.getOrThrow<number>('recipients.lookupRequestsPerWindow');
    const windowSeconds = this.config.getOrThrow<number>('recipients.lookupWindowSeconds');

    const key = this.keyFor(callerId);

    const results = await this.run(callerId, () => {
      // One round trip, for the same reason as the OTP counter: a crash between `INCR` and
      // `EXPIRE` would otherwise leave a key with no TTL, which turns a one-minute cap into a
      // permanent ban for that account.
      return this.redis.client.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    });

    if (results === null) {
      // The transaction was discarded, so the count is unknown - the same position as Redis
      // being unreachable.
      throw new RecipientLookupRateLimitUnavailableError();
    }

    const count = Number(results[0]?.[1] ?? 0);

    if (count > requestsPerWindow) {
      const ttl = await this.run(callerId, () => this.redis.client.ttl(key));

      // -1 is "key exists, no expiry" and -2 is "the key vanished between the two calls";
      // both answer with a full window, which is the honest thing to tell a caller.
      const retryAfterSeconds = typeof ttl === 'number' && ttl > 0 ? ttl : windowSeconds;

      this.logger.warn(
        `Recipient lookup limit reached for user ${callerId} (${count} in ${windowSeconds}s) - refusing`,
      );

      throw new RecipientLookupRateLimitExceededError(retryAfterSeconds);
    }
  }

  /**
   * The counter key: `recipients:lookup:<userId>`.
   *
   * Unhashed, deliberately unlike the OTP counter's `otp:requests:<sha256(phoneNumber)>`: the
   * reason that one is hashed is that a `KEYS` on a shared Redis must not print customers'
   * phone numbers, and a user id is not a phone number - it is the internal key that appears
   * in every log line and row already. Keeping it readable is what makes this key usable
   * during the incident it exists for ("who is sweeping, and how fast").
   */
  private keyFor(callerId: string): string {
    return `recipients:lookup:${callerId}`;
  }

  /**
   * Runs a Redis call, translating any failure into `RecipientLookupRateLimitUnavailableError`.
   *
   * Logged here rather than by the caller: the Redis error itself is what an operator needs,
   * while the caller only needs to know the allowance could not be evaluated.
   */
  private async run<T>(callerId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      this.logger.error(
        `Recipient lookup limit could not be evaluated for user ${callerId} - refusing the lookup`,
        cause instanceof Error ? cause.stack : String(cause),
      );

      throw new RecipientLookupRateLimitUnavailableError({ cause });
    }
  }
}
