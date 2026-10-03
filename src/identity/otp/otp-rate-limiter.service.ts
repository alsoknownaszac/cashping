import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhoneNumber } from '../../common/phone/phone-number.js';
import { RedisService } from '../../redis/redis.service.js';

/**
 * The caller asked for more codes than the window allows.
 *
 * Carries the wait so the caller can say how long, rather than "too many
 * requests" with no next step for the user.
 */
export class OtpRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many OTP requests; retry after ${retryAfterSeconds}s`);
    this.name = 'OtpRateLimitExceededError';
  }
}

/**
 * The limit could not be evaluated - Redis is unreachable.
 *
 * A distinct error from "over the limit" because it must *fail closed*: if we
 * cannot tell how many codes this number has already requested, the safe answer
 * is to not send one. Every send costs money and a pumped number is exactly the
 * scenario this limit exists for, so "assume fine" is the one wrong guess that
 * has a bill attached.
 */
export class OtpRateLimitUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Could not evaluate the OTP request limit', options);
    this.name = 'OtpRateLimitUnavailableError';
  }
}

/**
 * Caps how many requests one identifier can make (Step 13; reused by Steps 34b and 34c).
 *
 * A counter in Redis, not `@nestjs/throttler`: the throttler's default store is
 * per-process memory, so two API instances would each allow the full allowance and
 * a deploy would reset it - which is the wrong property for a limit whose purpose
 * is to cap SMS spend. The counter also has to be *per phone number* rather than
 * per IP: an attacker rotating IPs against one number is the attack, and a shared
 * IP (an office, a carrier NAT) is not.
 *
 * Fixed window rather than sliding: the worst case is up to `2 x` the allowance
 * across a window boundary, which is acceptable for a spend cap whose job is to
 * make pumping expensive rather than impossible. A sliding window (a sorted set
 * of timestamps) is the upgrade if the boundary ever gets abused.
 *
 * Read the ordering note in `AuthService.register`: this is called *after* the
 * cheap existence check, so probing an already-registered number cannot burn a
 * real user's allowance.
 *
 * Step 34b started counting password sign-in attempts here rather than in a limiter of its own,
 * and Step 34c widened the subject from "a number" to "the identifier the sign-in was submitted
 * with". One account's guesses are one attack whether the guesser is spending codes or
 * passwords, and two counters could disagree about how many tries the account gets.
 */
@Injectable()
export class OtpRateLimiterService {
  private readonly logger = new Logger(OtpRateLimiterService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Counts one request against the subject's allowance, throwing when the
   * allowance is already gone.
   *
   * The subject is the identifier the request was about: a phone number for the OTP endpoints,
   * and the number *or* the verified address a password sign-in was submitted with (Step 34c).
   * It is a plain string because the counter only ever hashes it into the key, while the
   * *masked* form is a second parameter - which mask is honest is a fact about the identifier,
   * and only the caller knows whether it is holding a number or an address.
   *
   * The blocked request still increments the counter (that is inherent to
   * `INCR`), but it does not extend the window: `EXPIRE ... NX` only sets the
   * TTL when the key is new, so a caller who keeps hammering cannot hold a
   * legitimate user's window open forever.
   */
  async consume(subject: string, masked = maskPhoneNumber(subject)): Promise<void> {
    const requestsPerWindow = this.config.getOrThrow<number>('otp.requestsPerWindow');
    const windowSeconds = this.config.getOrThrow<number>('otp.requestWindowMinutes') * 60;

    const key = this.keyFor(subject);

    const results = await this.run(masked, () => {
      // One round trip: `INCR` and the TTL in a single transaction, so the window
      // cannot be left without an expiry by a crash between two commands (which
      // would turn a 15-minute cap into a permanent ban).
      return this.redis.client.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    });

    if (results === null) {
      // A null result means the transaction was discarded and the count is
      // unknown - the same situation as Redis being unreachable.
      throw new OtpRateLimitUnavailableError();
    }

    const count = Number(results[0]?.[1] ?? 0);

    if (count > requestsPerWindow) {
      const ttl = await this.run(masked, () => this.redis.client.ttl(key));

      const retryAfterSeconds =
        // `ttl` is -1 for a key with no expiry and -2 for one that vanished
        // between the two calls; both fall back to a full window, which is the
        // honest answer ("wait, then try again").
        typeof ttl === 'number' && ttl > 0 ? ttl : windowSeconds;

      this.logger.warn(
        `OTP request limit reached for ${masked} (${count} in ${windowSeconds}s) - not sending`,
      );

      throw new OtpRateLimitExceededError(retryAfterSeconds);
    }
  }

  /**
   * The counter key: `otp:requests:<sha256(subject)>`.
   *
   * Hashed rather than the identifier itself, so a `KEYS otp:requests:*` on a shared
   * Redis instance does not print a list of customers' phone numbers (or, since Step 34c,
   * of their addresses). Nothing ever needs to read the key back into an identifier - the log
   * lines take the masked form - so the hash costs nothing.
   */
  private keyFor(subject: string): string {
    const digest = createHash('sha256').update(subject).digest('hex');

    return `otp:requests:${digest}`;
  }

  /**
   * Runs a Redis call, translating any failure into `OtpRateLimitUnavailableError`.
   *
   * Logged here rather than by the caller: the wait for an operator is the Redis
   * error itself, while the caller only needs to know the limit could not be
   * evaluated. `maskedSubject` is passed in rather than the raw value so this
   * line cannot be the one that logs a customer's number or address.
   */
  private async run<T>(maskedSubject: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      this.logger.error(
        `OTP rate limit could not be evaluated for ${maskedSubject} - refusing to send`,
        cause instanceof Error ? cause.stack : String(cause),
      );
      throw new OtpRateLimitUnavailableError({ cause });
    }
  }
}
