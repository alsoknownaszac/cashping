import { describe, expect, it } from 'vitest';
import { type RedisService } from '../../redis/redis.service.js';
import {
  IdempotencyStoreUnavailableError,
  RedisIdempotencyStore,
  type IdempotencyScope,
} from './idempotency-store.js';

/**
 * Step 24's storage half, tested against a fake Redis: what gets written, in what shape, with
 * what lifetime, and what a Redis that misbehaves produces.
 *
 * The live proof is `test/payments.e2e-spec.ts` (two rapid duplicate requests, one row); this
 * file is about the *protocol* the claim leans on - `SET NX` being the only command that decides
 * who runs, the record being readable by the next request, and every failure ending in
 * `IdempotencyStoreUnavailableError` rather than in a guess.
 *
 * The fake below models the three behaviours correctness depends on: `SET ... NX` answers `'OK'`
 * only when the key is absent, `SET` replaces the value and the TTL, and any command can reject
 * the way an unreachable Redis does.
 */

const SCOPE: IdempotencyScope = {
  route: 'POST /v1/payments',
  userId: '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41',
  key: 'b2d3f4a5-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
};

/** The key the store is expected to build for `SCOPE`. */
const REDIS_KEY = `idempotency:POST:/v1/payments:${SCOPE.userId}:${SCOPE.key}`;

const TTL_SECONDS = 86_400;
const REQUEST_HASH = 'a'.repeat(64);

/**
 * The slice of ioredis this store uses, spelled out so the fake cannot drift from it: if the
 * store starts issuing another command, this interface stops matching and the fake has to be
 * extended before the spec compiles.
 */
interface FakeRedisClient {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    seconds: number,
    setMode?: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * An in-memory Redis, with only the commands the store issues.
 *
 * `commands` records each call, which is how these tests assert *how* the claim was made
 * (`SET ... NX`, not a `GET` followed by a `SET`) rather than only what the answer was.
 */
class FakeRedis {
  readonly values = new Map<string, { value: string; ttlSeconds: number }>();
  readonly commands: string[] = [];

  /** When set, every command rejects - an unreachable Redis. */
  failing = false;

  /** When set, `SET ... NX` reports the key as taken whatever the map says. */
  pretendTaken = false;

  readonly client: FakeRedisClient = {
    set: async (key, value, _expiryMode, seconds, setMode) => {
      this.record(`set${setMode === 'NX' ? ':nx' : ''}`, key, seconds);

      if (setMode === 'NX' && (this.pretendTaken || this.values.has(key))) {
        return null;
      }

      this.values.set(key, { value, ttlSeconds: seconds });

      return 'OK';
    },
    get: async (key) => {
      this.record('get', key);

      return this.values.get(key)?.value ?? null;
    },
    del: async (key) => {
      this.record('del', key);

      return this.values.delete(key) ? 1 : 0;
    },
  };

  /** Seeds a key directly, as a previous request would have left it. */
  seed(key: string, value: string, ttlSeconds = TTL_SECONDS): void {
    this.values.set(key, { value, ttlSeconds });
  }

  private record(command: string, key: string, seconds?: number): void {
    if (this.failing) {
      throw new Error('redis is unreachable');
    }

    this.commands.push(
      seconds === undefined ? `${command} ${key}` : `${command} ${key} (${seconds}s)`,
    );
  }
}

describe('claim', () => {
  it('takes a free key with one SET NX, storing the request hash and the TTL', async () => {
    const { redis, store } = createStore();

    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).resolves.toEqual({
      kind: 'claimed',
    });

    // The claim is the key's existence: no `GET` first, because two requests both reading
    // "free" before either writes is the race this store exists to remove.
    expect(redis.commands).toEqual([`set:nx ${REDIS_KEY} (${TTL_SECONDS}s)`]);
    expect(redis.values.get(REDIS_KEY)?.value).toBe(JSON.stringify({ requestHash: REQUEST_HASH }));
    // The TTL is on the *claim*, not only on the stored result: a process that dies mid-request
    // must not hold its key until somebody notices.
    expect(redis.values.get(REDIS_KEY)?.ttlSeconds).toBe(TTL_SECONDS);
  });

  it('reports an in-flight claim as taken, carrying the hash and no body', async () => {
    const { redis, store } = createStore();
    redis.seed(REDIS_KEY, JSON.stringify({ requestHash: REQUEST_HASH }));

    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).resolves.toEqual({
      kind: 'taken',
      record: { requestHash: REQUEST_HASH },
    });
  });

  it('reports a completed claim as taken, carrying the response body', async () => {
    const { redis, store } = createStore();
    const body = { id: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70', status: 'PENDING' };
    redis.seed(REDIS_KEY, JSON.stringify({ requestHash: REQUEST_HASH, body }));

    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).resolves.toEqual({
      kind: 'taken',
      record: { requestHash: REQUEST_HASH, body },
    });
  });

  it('scopes the key per route, caller and client key', async () => {
    const { redis, store } = createStore();

    await store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS);
    await store.claim({ ...SCOPE, key: 'a-different-key' }, REQUEST_HASH, TTL_SECONDS);
    await store.claim({ ...SCOPE, route: 'POST /v1/payments/retry' }, REQUEST_HASH, TTL_SECONDS);
    await store.claim({ ...SCOPE, userId: 'someone-else' }, REQUEST_HASH, TTL_SECONDS);

    // Four claims, four keys: the same string from another client (or on another route) is a
    // different payment, which is the whole reason the key is not global.
    expect(new Set(redis.values.keys()).size).toBe(4);
  });

  it('refuses rather than guessing when the key vanished between the two commands', async () => {
    const { redis, store } = createStore();
    // `SET NX` says the key exists, `GET` says it does not: it expired (or was released) in
    // between. Calling that "taken" answers a client with a duplicate for a request that is not
    // there; calling it "claimed" would run the payment a second time. Neither is a guess worth
    // making.
    redis.pretendTaken = true;

    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).rejects.toBeInstanceOf(
      IdempotencyStoreUnavailableError,
    );
  });

  it('refuses a record it cannot read rather than treating the key as free', async () => {
    for (const stored of ['not json at all', '{}', '{"requestHash":42}']) {
      const { redis, store } = createStore();
      redis.seed(REDIS_KEY, stored);

      await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).rejects.toBeInstanceOf(
        IdempotencyStoreUnavailableError,
      );
    }
  });

  it('fails closed when Redis is unreachable', async () => {
    const { redis, store } = createStore();
    redis.failing = true;

    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).rejects.toBeInstanceOf(
      IdempotencyStoreUnavailableError,
    );
  });
});

describe('record', () => {
  it('replaces the claim with the response, refreshing the TTL', async () => {
    const { redis, store } = createStore();
    await store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS);

    const body = { id: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70' };
    await store.record(SCOPE, { requestHash: REQUEST_HASH, body }, TTL_SECONDS);

    expect(redis.values.get(REDIS_KEY)?.value).toBe(
      JSON.stringify({ requestHash: REQUEST_HASH, body }),
    );
    // A plain `SET`, i.e. not `NX`: this request holds the key and is replacing its own
    // placeholder with the answer a duplicate will read.
    expect(redis.commands.at(-1)).toBe(`set ${REDIS_KEY} (${TTL_SECONDS}s)`);
  });

  it('fails closed when Redis is unreachable', async () => {
    const { redis, store } = createStore();
    redis.failing = true;

    await expect(
      store.record(SCOPE, { requestHash: REQUEST_HASH, body: {} }, TTL_SECONDS),
    ).rejects.toBeInstanceOf(IdempotencyStoreUnavailableError);
  });
});

describe('release', () => {
  it('drops the claim, so the key can be used again', async () => {
    const { redis, store } = createStore();
    await store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS);

    await store.release(SCOPE);

    expect(redis.values.has(REDIS_KEY)).toBe(false);
    await expect(store.claim(SCOPE, REQUEST_HASH, TTL_SECONDS)).resolves.toEqual({
      kind: 'claimed',
    });
  });

  it('fails closed when Redis is unreachable', async () => {
    const { redis, store } = createStore();
    redis.failing = true;

    await expect(store.release(SCOPE)).rejects.toBeInstanceOf(IdempotencyStoreUnavailableError);
  });
});

function createStore(redis = new FakeRedis()): { redis: FakeRedis; store: RedisIdempotencyStore } {
  return {
    redis,
    store: new RedisIdempotencyStore({ client: redis.client } as unknown as RedisService),
  };
}
