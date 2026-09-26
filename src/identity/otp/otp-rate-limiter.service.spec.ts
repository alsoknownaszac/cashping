import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { type RedisService } from '../../redis/redis.service.js';
import {
  OtpRateLimitExceededError,
  OtpRateLimitUnavailableError,
  OtpRateLimiterService,
} from './otp-rate-limiter.service.js';

/**
 * Step 13's spend cap, tested against a fake Redis rather than a real one: what
 * matters here is the *policy* (how many, per whom, for how long, and what happens
 * when Redis cannot answer), not whether ioredis can talk to a server - the e2e
 * suite covers that against the compose stack.
 */

/** A valid Ghanaian mobile, in the strict E.164 the limiter is always handed. */
const NUMBER = '+233241234567';
const OTHER_NUMBER = '+233201234567';

/** The OTP policy `configuration()` supplies, as the limiter reads it. */
const OTP_CONFIG: Readonly<Record<string, number>> = {
  'otp.requestsPerWindow': 3,
  'otp.requestWindowMinutes': 15,
};

/** The window both the TTL and the "try again in" message are derived from. */
const WINDOW_SECONDS = 15 * 60;

function createConfig(overrides: Readonly<Record<string, number>> = {}): ConfigService {
  const values = { ...OTP_CONFIG, ...overrides };

  return { getOrThrow: (key: string) => values[key] } as unknown as ConfigService;
}

/**
 * The slice of ioredis the limiter uses, spelled out so the fake cannot quietly
 * drift from it: if the service starts issuing another command, this interface
 * stops matching and the fake has to be extended before the tests will compile.
 */
interface Chain {
  incr(key: string): Chain;
  expire(key: string, seconds: number, mode: 'NX'): Chain;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * An in-memory stand-in for Redis, exposing only `multi()` and `ttl()`.
 *
 * It models the two behaviours the limiter's correctness leans on: `EXPIRE ... NX`
 * sets the TTL only the first time, and `EXEC` either applies the queued commands,
 * resolves `null` (transaction discarded) or rejects (server unreachable).
 */
class FakeRedis {
  /** One entry per key the limiter touched, so tests can inspect keys and TTLs. */
  readonly entries = new Map<string, { count: number; ttlSeconds: number | null }>();

  /** Every command rejects, as an unreachable Redis does. */
  failing = false;

  /** `EXEC` resolves `null`, as a discarded WATCH transaction does. */
  discarded = false;

  /** When set, only `TTL` rejects - Redis dying between the two commands. */
  ttlFailing = false;

  /** When set, `TTL` reports this instead of the stored value (-1 / -2 from Redis). */
  ttlOverride: number | null = null;

  readonly client = {
    multi: (): Chain => {
      const operations: Array<() => void> = [];
      let count = 0;

      const chain: Chain = {
        incr: (key) => {
          operations.push(() => {
            const entry = this.entry(key);
            entry.count += 1;
            count = entry.count;
          });

          return chain;
        },
        expire: (key, seconds) => {
          operations.push(() => {
            const entry = this.entry(key);
            if (entry.ttlSeconds === null) {
              entry.ttlSeconds = seconds;
            }
          });

          return chain;
        },
        exec: async () => {
          if (this.failing) {
            throw new Error('connect ECONNREFUSED 127.0.0.1:6380');
          }

          if (this.discarded) {
            return null;
          }

          for (const apply of operations) {
            apply();
          }

          return [
            [null, count],
            [null, 1],
          ];
        },
      };

      return chain;
    },
    ttl: async (key: string): Promise<number> => {
      if (this.failing || this.ttlFailing) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6380');
      }

      return this.ttlOverride ?? this.entries.get(key)?.ttlSeconds ?? -2;
    },
  };

  private entry(key: string): { count: number; ttlSeconds: number | null } {
    let entry = this.entries.get(key);

    if (entry === undefined) {
      entry = { count: 0, ttlSeconds: null };
      this.entries.set(key, entry);
    }

    return entry;
  }
}

function createLimiter(options: { redis?: FakeRedis; config?: ConfigService } = {}): {
  redis: FakeRedis;
  limiter: OtpRateLimiterService;
} {
  const redis = options.redis ?? new FakeRedis();

  return {
    redis,
    limiter: new OtpRateLimiterService(
      redis as unknown as RedisService,
      options.config ?? createConfig(),
    ),
  };
}

/** Runs `operation` and returns the error it threw; fails if it did not throw. */
async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (caught) {
    return caught;
  }

  throw new Error('expected the call to reject, but it resolved');
}

describe('OtpRateLimiterService.consume', () => {
  it('allows a number its full allowance', async () => {
    const { limiter } = createLimiter();

    await expect(limiter.consume(NUMBER)).resolves.toBeUndefined();
    await expect(limiter.consume(NUMBER)).resolves.toBeUndefined();
    await expect(limiter.consume(NUMBER)).resolves.toBeUndefined();
  });

  it('refuses the request after the allowance, saying how long to wait', async () => {
    const { limiter } = createLimiter();

    for (let i = 0; i < OTP_CONFIG['otp.requestsPerWindow']!; i += 1) {
      await limiter.consume(NUMBER);
    }

    const error = await captureError(() => limiter.consume(NUMBER));

    expect(error).toBeInstanceOf(OtpRateLimitExceededError);
    // The wait comes from the key's own TTL, so the user is told the truth about
    // *their* window rather than up to 15 minutes of "try again" that would fail
    // again.
    expect((error as OtpRateLimitExceededError).retryAfterSeconds).toBe(WINDOW_SECONDS);
  });

  it('counts each phone number separately, so one user cannot block another', async () => {
    const { redis, limiter } = createLimiter();

    for (let i = 0; i < OTP_CONFIG['otp.requestsPerWindow']!; i += 1) {
      await limiter.consume(NUMBER);
    }

    await expect(limiter.consume(OTHER_NUMBER)).resolves.toBeUndefined();
    expect(redis.entries.size).toBe(2);
  });

  it('does not let a blocked caller extend the window by hammering', async () => {
    const { redis, limiter } = createLimiter();

    for (let i = 0; i < OTP_CONFIG['otp.requestsPerWindow']!; i += 1) {
      await limiter.consume(NUMBER);
    }

    for (let i = 0; i < 7; i += 1) {
      await captureError(() => limiter.consume(NUMBER));
    }

    const [entry] = [...redis.entries.values()];

    // The blocked requests still count (INCR is unconditional) but `EXPIRE ... NX`
    // leaves the deadline where the first request put it, so the allowance comes
    // back on schedule instead of being held closed for as long as the attacker
    // keeps asking.
    expect(entry?.count).toBe(10);
    expect(entry?.ttlSeconds).toBe(WINDOW_SECONDS);
  });

  it('keys the counter by a hash of the number, never the number itself', async () => {
    const { redis, limiter } = createLimiter();

    await limiter.consume(NUMBER);
    await limiter.consume(NUMBER);

    const [key] = [...redis.entries.keys()];

    // One key for two requests: the same number always lands on the same counter.
    expect(key).toMatch(/^otp:requests:[0-9a-f]{64}$/);
    // Nothing in the keyspace reveals who was counted - a `KEYS otp:requests:*` on
    // a shared Redis must not print a customer list.
    expect(key).not.toContain('233241234567');
  });

  it('falls back to a full window when the counter has no usable TTL', async () => {
    const { redis, limiter } = createLimiter();

    for (let i = 0; i < OTP_CONFIG['otp.requestsPerWindow']!; i += 1) {
      await limiter.consume(NUMBER);
    }

    // -1 is "key exists, no expiry" and -2 is "key is gone"; neither is a wait a
    // user could be told, so both answer with the configured window.
    for (const ttl of [-1, -2]) {
      redis.ttlOverride = ttl;

      const error = await captureError(() => limiter.consume(NUMBER));

      expect((error as OtpRateLimitExceededError).retryAfterSeconds).toBe(WINDOW_SECONDS);
    }
  });

  it('reads the policy from configuration rather than hard-coding it', async () => {
    const config = createConfig({
      'otp.requestsPerWindow': 1,
      'otp.requestWindowMinutes': 1,
    });
    const { redis, limiter } = createLimiter({ config });

    await limiter.consume(NUMBER);
    const error = await captureError(() => limiter.consume(NUMBER));

    expect((error as OtpRateLimitExceededError).retryAfterSeconds).toBe(60);
    expect([...redis.entries.values()][0]?.ttlSeconds).toBe(60);
  });

  it('fails closed when Redis is unreachable', async () => {
    const { redis, limiter } = createLimiter();
    redis.failing = true;

    const error = await captureError(() => limiter.consume(NUMBER));

    // The distinction matters: "over the limit" is a 429 for a user who waited,
    // while "could not evaluate" is a 503 - and it is deliberately *not* treated
    // as "fine", because assuming an unverifiable counter is empty is the one
    // guess with an SMS bill attached.
    expect(error).toBeInstanceOf(OtpRateLimitUnavailableError);
    expect(error).not.toBeInstanceOf(OtpRateLimitExceededError);
  });

  it('fails closed when the transaction is discarded', async () => {
    const { redis, limiter } = createLimiter();
    redis.discarded = true;

    // `EXEC` resolving `null` means the count never happened and cannot be
    // trusted, which is the same position as Redis being unreachable.
    await expect(captureError(() => limiter.consume(NUMBER))).resolves.toBeInstanceOf(
      OtpRateLimitUnavailableError,
    );
  });

  it('fails closed when the TTL lookup fails after the counter was incremented', async () => {
    const { redis, limiter } = createLimiter();

    for (let i = 0; i < OTP_CONFIG['otp.requestsPerWindow']!; i += 1) {
      await limiter.consume(NUMBER);
    }

    // Redis dying between the two commands must not produce an error carrying an
    // undefined wait, which the caller would turn into "try again in NaN minutes".
    redis.ttlFailing = true;

    await expect(captureError(() => limiter.consume(NUMBER))).resolves.toBeInstanceOf(
      OtpRateLimitUnavailableError,
    );
  });
});
