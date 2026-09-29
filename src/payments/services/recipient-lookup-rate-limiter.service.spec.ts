import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { type RedisService } from '../../redis/redis.service.js';
import {
  RecipientLookupRateLimitExceededError,
  RecipientLookupRateLimitUnavailableError,
  RecipientLookupRateLimiter,
} from './recipient-lookup-rate-limiter.service.js';

/**
 * Step 21's lookup cap, tested against a fake Redis rather than a real one: what matters here is
 * the *policy* - how many lookups, per whom, for how long, and what happens when Redis cannot
 * answer - while `test/recipients.e2e-spec.ts` spends an allowance over real HTTP against the
 * compose Redis, which is where the 429 is proven end to end.
 *
 * Two decisions this file exists to pin down, because both are about what the endpoint discloses
 * rather than about counting:
 *
 * 1. The counter is keyed by the *caller*, not by IP. An account is what sweeps, so an account is
 *    what pays: rotating IPs must not buy more allowance, and a shared office IP must not share
 *    one.
 * 2. It fails closed. An allowance that cannot be read is not an allowance that is unspent -
 *    assuming otherwise hands over the directory for as long as Redis is down.
 */

/** The allowance `configuration()` supplies, as the limiter reads it. */
const LOOKUP_CONFIG: Readonly<Record<string, number>> = {
  'recipients.lookupRequestsPerWindow': 20,
  'recipients.lookupWindowSeconds': 60,
};

/** The two numbers the policy is made of, named so the tests below read as sentences. */
const ALLOWANCE = LOOKUP_CONFIG['recipients.lookupRequestsPerWindow'] as number;
const WINDOW_SECONDS = LOOKUP_CONFIG['recipients.lookupWindowSeconds'] as number;

/** Two callers, so "per caller" is a test rather than a claim. */
const CALLER = '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41';
const OTHER_CALLER = '1b7e5a02-8c46-4d1e-8f0b-2c7a9d3e5f60';

function createConfig(overrides: Readonly<Record<string, number>> = {}): ConfigService {
  const values = { ...LOOKUP_CONFIG, ...overrides };

  return { getOrThrow: (key: string) => values[key] } as unknown as ConfigService;
}

/**
 * The slice of ioredis the limiter uses, spelled out so the fake cannot quietly drift from it:
 * if the service starts issuing another command, this interface stops matching and the fake has
 * to be extended before the tests compile.
 */
interface Chain {
  incr(key: string): Chain;
  expire(key: string, seconds: number, mode: 'NX'): Chain;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * An in-memory stand-in for Redis, exposing only `multi()` and `ttl()`.
 *
 * It models the three behaviours the limiter's correctness leans on: `INCR` answers with the new
 * count for the key it was given, `EXPIRE ... NX` sets the TTL only the first time, and `EXEC`
 * either applies the queued commands, resolves `null` (transaction discarded) or rejects (server
 * unreachable).
 */
class FakeRedis {
  /** One entry per key the limiter touched, so tests can inspect counts and TTLs. */
  readonly entries = new Map<string, { count: number; ttlSeconds: number | null }>();

  /** Every command rejects, as an unreachable Redis does. */
  failing = false;

  /** `EXEC` resolves `null`, as a discarded transaction does. */
  discarded = false;

  /** When set, only `TTL` rejects - Redis dying between the two commands. */
  ttlFailing = false;

  /** When set, `TTL` reports this instead of the stored value (-1 / -2 from Redis). */
  ttlOverride: number | null = null;

  readonly client = {
    multi: (): Chain => {
      const operations: Array<() => void> = [];
      let countedKey: string | null = null;

      const chain: Chain = {
        incr: (key) => {
          operations.push(() => {
            countedKey = key;
            this.entry(key).count += 1;
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
            throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
          }

          if (this.discarded) {
            return null;
          }

          for (const operation of operations) {
            operation();
          }

          // What Redis answers: one `[error, reply]` pair per queued command, and `INCR`'s reply
          // is the new count - the only value the limiter reads out of the transaction.
          return [[null, this.entry(countedKey as string).count]];
        },
      };

      return chain;
    },
    ttl: async (key: string) => {
      if (this.failing || this.ttlFailing) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }

      return this.ttlOverride ?? this.entry(key).ttlSeconds ?? -2;
    },
  };

  private entry(key: string): { count: number; ttlSeconds: number | null } {
    const existing = this.entries.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created = { count: 0, ttlSeconds: null as number | null };
    this.entries.set(key, created);

    return created;
  }
}

function createLimiter(options: { config?: ConfigService } = {}): {
  redis: FakeRedis;
  limiter: RecipientLookupRateLimiter;
} {
  const redis = new FakeRedis();

  return {
    redis,
    limiter: new RecipientLookupRateLimiter(
      redis as unknown as RedisService,
      options.config ?? createConfig(),
    ),
  };
}

/** The error a call threw; the limiter reports by throwing, so this is how it is read. */
async function captureError(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Spends `count` lookups, asserting nothing about the answers. */
async function spend(
  limiter: RecipientLookupRateLimiter,
  count: number,
  caller = CALLER,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await limiter.consume(caller);
  }
}

describe('RecipientLookupRateLimiter', () => {
  it('allows the configured number of lookups and refuses the next one', async () => {
    const { limiter } = createLimiter();

    await spend(limiter, ALLOWANCE);

    const error = await captureError(() => limiter.consume(CALLER));

    // The last of the allowance is allowed, so the boundary is exact in both directions: a limit
    // of 20 that refuses the twentieth lookup would be a limit of 19.
    expect(error).toBeInstanceOf(RecipientLookupRateLimitExceededError);
    expect((error as RecipientLookupRateLimitExceededError).retryAfterSeconds).toBe(WINDOW_SECONDS);
  });

  it('refuses with the wait, so the client can show a countdown', async () => {
    const { limiter } = createLimiter();

    await spend(limiter, ALLOWANCE);

    const error = await captureError(() => limiter.consume(CALLER));

    // A 429 that says only "slow down" leaves the person pressing the button again; the seconds
    // are the whole reason the error carries them.
    expect((error as Error).message).toContain(String(WINDOW_SECONDS));
  });

  it('counts per caller, so one account cannot spend another account’s allowance', async () => {
    const { limiter } = createLimiter();

    await spend(limiter, ALLOWANCE);
    await expect(captureError(() => limiter.consume(CALLER))).resolves.toBeInstanceOf(
      RecipientLookupRateLimitExceededError,
    );

    // The same request from a different account is allowed. Keying by IP instead would refuse it
    // (both callers here share an address), and keying by nothing would let a sweep of many
    // accounts pass uncounted.
    await expect(limiter.consume(OTHER_CALLER)).resolves.toBeUndefined();
  });

  it('keys the counter by the caller id, readable for the incident it exists for', async () => {
    const { redis, limiter } = createLimiter();

    await limiter.consume(CALLER);

    // Deliberately *not* hashed, unlike the OTP counter's `otp:requests:<sha256(phoneNumber)>`:
    // that one is hashed so a `KEYS` on a shared Redis cannot print customers' phone numbers, and
    // a user id is already in every log line and row. Readable is what makes "who is sweeping,
    // and how fast" answerable during an incident.
    expect([...redis.entries.keys()]).toEqual([`recipients:lookup:${CALLER}`]);
  });

  it('sets the window on the first lookup only, so a refused caller cannot hold it open', async () => {
    const { redis, limiter } = createLimiter();

    await limiter.consume(CALLER);

    expect(redis.entries.get(`recipients:lookup:${CALLER}`)?.ttlSeconds).toBe(WINDOW_SECONDS);

    // Hammering past the limit increments the counter (that is what `INCR` does) but must not
    // extend the TTL: otherwise a caller who keeps asking would never see the window expire,
    // which turns a one-minute cap into a permanent ban - for themselves alone, since the key is
    // theirs, but a support ticket all the same.
    for (let i = 0; i < ALLOWANCE * 2; i += 1) {
      await captureError(() => limiter.consume(CALLER));
    }

    expect(redis.entries.get(`recipients:lookup:${CALLER}`)?.ttlSeconds).toBe(WINDOW_SECONDS);
  });

  it('reads the policy from configuration rather than hard-coding it', async () => {
    const config = createConfig({
      'recipients.lookupRequestsPerWindow': 1,
      'recipients.lookupWindowSeconds': 30,
    });
    const { redis, limiter } = createLimiter({ config });

    await limiter.consume(CALLER);

    const error = await captureError(() => limiter.consume(CALLER));

    expect((error as RecipientLookupRateLimitExceededError).retryAfterSeconds).toBe(30);
    expect(redis.entries.get(`recipients:lookup:${CALLER}`)?.ttlSeconds).toBe(30);
  });

  it('falls back to a full window when the counter has no usable TTL', async () => {
    const { redis, limiter } = createLimiter();

    await spend(limiter, ALLOWANCE);

    // -1 is "the key exists, with no expiry" and -2 is "the key vanished between the two calls";
    // neither is a wait a caller could be told, so both answer with the configured window. `NaN`
    // in a "try again in NaN seconds" message is the failure this excludes.
    for (const ttl of [-1, -2]) {
      redis.ttlOverride = ttl;

      const error = await captureError(() => limiter.consume(CALLER));

      expect((error as RecipientLookupRateLimitExceededError).retryAfterSeconds).toBe(
        WINDOW_SECONDS,
      );
    }
  });

  it('fails closed when Redis is unreachable', async () => {
    const { redis, limiter } = createLimiter();
    redis.failing = true;

    const error = await captureError(() => limiter.consume(CALLER));

    // The distinction matters over the wire: "over the limit" is a 429 for a caller who waited,
    // while "could not evaluate" is a 503 - and it is deliberately *not* treated as "fine".
    // Assuming an unreadable counter is empty is the one guess that hands over the directory.
    expect(error).toBeInstanceOf(RecipientLookupRateLimitUnavailableError);
    expect(error).not.toBeInstanceOf(RecipientLookupRateLimitExceededError);
  });

  it('fails closed when the transaction is discarded', async () => {
    const { redis, limiter } = createLimiter();
    redis.discarded = true;

    // `EXEC` resolving `null` means the count never happened and cannot be trusted, which is the
    // same position as Redis being unreachable - so the same answer, not a lookup that proceeds.
    await expect(captureError(() => limiter.consume(CALLER))).resolves.toBeInstanceOf(
      RecipientLookupRateLimitUnavailableError,
    );
  });

  it('fails closed when the TTL lookup fails after the counter was incremented', async () => {
    const { redis, limiter } = createLimiter();

    await spend(limiter, ALLOWANCE);

    // Redis dying between `INCR` and `TTL` must not produce a refused lookup whose wait is
    // undefined - a client would render "try again in NaN seconds" - so this is unavailable
    // rather than exceeded.
    redis.ttlFailing = true;

    await expect(captureError(() => limiter.consume(CALLER))).resolves.toBeInstanceOf(
      RecipientLookupRateLimitUnavailableError,
    );
  });
});
