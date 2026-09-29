import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service.js';

/**
 * Where a request's idempotency claim and its result live (Step 24).
 *
 * Redis, for the reasons the two rate limiters give and one that is specific to money:
 * the claim has to be *shared*, because a duplicate may land on a second API instance,
 * and it has to survive a restart, because a client that retried after a deploy is
 * exactly the case this exists for. A per-process `Map` would answer "duplicate" only
 * when both requests happened to hit the same instance - which is how a double payment
 * survives a test suite and appears in production.
 *
 * ## The record
 *
 * One key per (route, caller, client key), holding one JSON object:
 *
 *     idempotency:POST:/v1/payments:<userId>:<client key>
 *     {"requestHash":"<sha256>","body":{...}}     # completed: body is the response
 *     {"requestHash":"<sha256>"}                  # in flight: no response yet
 *
 * The claim *is* the key's existence: `SET ... NX` is the atomic compare-and-set that
 * makes "only one request runs" true without a lock, a transaction or a `WATCH`. A
 * second request reads the same key and finds a record - with a `body` it is a
 * completed request to replay, without one the first request is still running.
 *
 * `requestHash` is stored because a key identifies a *request*, not a route: the same
 * key with a different body is a client bug, and answering it with the first request's
 * result would be the wrong answer twice over (the client would believe a payment it
 * did not describe). The interceptor compares the two and refuses the second.
 *
 * The status code is deliberately *not* stored: a replayed response goes back through
 * the same route, so the framework applies that route's own `@HttpCode` to it, and a
 * stored copy could only ever disagree with that. See `IdempotencyInterceptor`.
 *
 * ## Failing closed
 *
 * Every Redis failure becomes `IdempotencyStoreUnavailableError`, and the interceptor
 * turns that into a 503 rather than letting the request through: a claim that cannot be
 * written is a duplicate that cannot be detected. The database's unique index is the
 * backstop *below* this - see `Transaction` in `schema.prisma` - which is why a 503
 * here is a refusal and not a lost payment.
 */

/**
 * The key, as the interceptor passes it here: three parts, so the Redis key can be built
 * in exactly one place.
 *
 * `route` is the method and path (`POST /v1/payments`), so the same key on a different
 * endpoint - or on a different resource of the same endpoint - is a different
 * operation, which is how every API with this feature scopes a key. The caller is part
 * of it because the client generates the string and two clients may pick the same one.
 */
export interface IdempotencyScope {
  /** The HTTP method and path, as the request identifies itself. */
  readonly route: string;
  /** The authenticated caller. */
  readonly userId: string;
  /** The client's own key, from the `Idempotency-Key` header. */
  readonly key: string;
}

/** What a completed request left behind, so a duplicate can be answered with it. */
export interface IdempotencyRecord {
  /** SHA-256 of the request body as it arrived, so a re-spelled request is refused. */
  readonly requestHash: string;
  /** The response body the handler produced; absent while the request is in flight. */
  readonly body?: unknown;
}

/** The outcome of trying to claim a key. */
export type IdempotencyClaim =
  /** The key was unused and is now claimed: this request is the one that runs. */
  | { readonly kind: 'claimed' }
  /** Somebody else has it - either still running, or finished and answerable. */
  | { readonly kind: 'taken'; readonly record: IdempotencyRecord };

/** The claim could not be read or written - Redis is unreachable or unusable. */
export class IdempotencyStoreUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Could not evaluate the idempotency key', options);
    this.name = 'IdempotencyStoreUnavailableError';
  }
}

/**
 * What the interceptor needs from the store, as a type.
 *
 * The interceptor depends on this rather than on Redis, which is what lets its spec
 * drive every branch - in flight, completed, Redis down - without a Redis server.
 */
export interface IdempotencyStore {
  claim(
    scope: IdempotencyScope,
    requestHash: string,
    ttlSeconds: number,
  ): Promise<IdempotencyClaim>;
  /** Attaches the response to a claim, making it replayable for the rest of the TTL. */
  record(scope: IdempotencyScope, record: IdempotencyRecord, ttlSeconds: number): Promise<void>;
  /** Drops a claim whose request failed, so the key can be used again. */
  release(scope: IdempotencyScope): Promise<void>;
}

/** The Redis implementation. The only one: the interface above exists for the tests. */
@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly logger = new Logger(RedisIdempotencyStore.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Takes the key if it is free, or reports who holds it.
   *
   * `SET key value EX ttl NX` in one command, deliberately: a `GET` followed by a `SET`
   * is the race this whole step exists to remove, because both callers read "free"
   * before either writes. `EX` is set on the *claim*, not only on the result, so a
   * process that dies mid-request cannot leave a key that blocks its client forever:
   * the claim expires and a retry is allowed, and the database's unique index still
   * refuses a second row if the first request actually completed.
   */
  async claim(
    scope: IdempotencyScope,
    requestHash: string,
    ttlSeconds: number,
  ): Promise<IdempotencyClaim> {
    const key = keyFor(scope);
    const claimed = await this.run(key, () =>
      this.redis.client.set(key, JSON.stringify({ requestHash }), 'EX', ttlSeconds, 'NX'),
    );

    if (claimed === 'OK') {
      return { kind: 'claimed' };
    }

    const stored = await this.run(key, () => this.redis.client.get(key));

    /**
     * `SET ... NX` said no but the key is gone: it expired (or was released) between the
     * two commands. Calling that "taken" would answer a client with a duplicate for a
     * request that is not there, so the honest move is to refuse rather than guess -
     * the same position as Redis being unreachable, and something a retry can fix.
     */
    if (stored === null) {
      throw new IdempotencyStoreUnavailableError();
    }

    return { kind: 'taken', record: this.parse(key, stored) };
  }

  /**
   * Stores the response against the claim.
   *
   * A plain `SET` rather than `NX`, because this request holds the key and is replacing
   * its own placeholder. The TTL is refreshed here, so the replay window is a full one
   * measured from the response rather than from the claim.
   */
  async record(
    scope: IdempotencyScope,
    record: IdempotencyRecord,
    ttlSeconds: number,
  ): Promise<void> {
    const key = keyFor(scope);

    await this.run(key, () => this.redis.client.set(key, JSON.stringify(record), 'EX', ttlSeconds));
  }

  /**
   * Gives the key back after a request that produced no result.
   *
   * Only called when the handler *failed*, so that a refused payment (not enough
   * balance, a recipient that is not payable, a malformed amount) can be retried with
   * the same key instead of being answered with that failure until the TTL runs out. A
   * successful request keeps its key, which is the whole point of the step.
   *
   * `DEL` without a compare is safe here, for a reason worth stating: the TTL is a day
   * (see `IDEMPOTENCY_TTL_SECONDS`) and the handler is one database write, so no second
   * claim can exist while this request releases - one would have to expire *and* be
   * re-taken inside this same request. A shorter TTL would need a compare-and-delete (a
   * Lua script), and this comment is where that would be recorded.
   */
  async release(scope: IdempotencyScope): Promise<void> {
    await this.run(keyFor(scope), () => this.redis.client.del(keyFor(scope)));
  }

  /**
   * Reads the record this store wrote, or refuses to guess.
   *
   * A record that is not the shape above means something else is writing to this
   * namespace, or a value was corrupted. Not knowing whether the request is a duplicate
   * is the one state that must not proceed, so it is reported as unavailable - the
   * caller refuses and the client retries - rather than treated as a free key.
   */
  private parse(key: string, stored: string): IdempotencyRecord {
    try {
      const record = JSON.parse(stored) as IdempotencyRecord;

      if (typeof record.requestHash !== 'string') {
        throw new Error('the stored record has no request hash');
      }

      return record;
    } catch (cause) {
      this.logger.error(
        `Idempotency record at ${key} is not readable - refusing the request`,
        cause instanceof Error ? cause.stack : String(cause),
      );

      throw new IdempotencyStoreUnavailableError({ cause });
    }
  }

  /**
   * Runs one Redis call, translating any failure into
   * `IdempotencyStoreUnavailableError`.
   *
   * Logged here rather than by the caller: the Redis error itself is what an operator
   * needs, while the caller only needs to know that the key could not be evaluated.
   */
  private async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      this.logger.error(
        `Idempotency key at ${key} could not be evaluated - refusing the request`,
        cause instanceof Error ? cause.stack : String(cause),
      );

      throw new IdempotencyStoreUnavailableError({ cause });
    }
  }
}

/**
 * The one place the Redis key's shape is decided.
 *
 * `POST /v1/payments` becomes `POST:/v1/payments`, and everything that must not appear
 * in a Redis key (a space, a newline) is gone: the space is replaced rather than
 * escaped so the key is readable with `KEYS idempotency:*` during the incident it
 * exists for.
 */
function keyFor(scope: IdempotencyScope): string {
  return `idempotency:${scope.route.replace(/\s+/g, ':')}:${scope.userId}:${scope.key}`;
}
