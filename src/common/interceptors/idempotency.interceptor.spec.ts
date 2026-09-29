import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_TTL_SECONDS } from '../../config/configuration.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import {
  IdempotencyStoreUnavailableError,
  RedisIdempotencyStore,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotencyStore,
} from './idempotency-store.js';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyInterceptor,
  hashRequestBody,
} from './idempotency.interceptor.js';

/**
 * Step 24's policy, tested against a fake store: which request runs, which one is answered from
 * the store, and what each refusal means.
 *
 * The live proof - two rapid duplicate requests producing exactly one `transactions` row - is
 * `test/payments.e2e-spec.ts`, because that claim is about a row count. What can only be tested
 * here is the *branching*: a duplicate in flight, a duplicate completed, a key reused with a
 * different body, a handler that failed, a store that cannot answer. The last one is the reason
 * this file exists at all: "Redis is down" must be a refusal, and no e2e can show what did not
 * happen as sharply as a fake that refuses every call can.
 */

/** The user every request in this file is made by, unless a test says otherwise. */
const CALLER: SessionUser = {
  id: '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41',
  phoneNumber: '+233241234567',
  status: 'ACTIVE',
  handle: 'ama',
};

const CLIENT_KEY = 'b2d3f4a5-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

/** What the handler answers a fresh request with - the shape `POST /v1/payments` returns. */
const BODY = { id: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70', status: 'PENDING', amount: '25.5' };

/** The store, as the interceptor uses it, with every branch under the test's control. */
class FakeStore implements IdempotencyStore {
  /** Every scope the interceptor claimed, in order - so scoping is asserted, not assumed. */
  readonly claims: IdempotencyScope[] = [];
  /** What was stored against a key, so "the response is remembered" is checkable. */
  readonly records: IdempotencyRecord[] = [];
  readonly released: IdempotencyScope[] = [];
  /** Every method refuses, as an unreachable Redis does. */
  failing = false;
  /** Only `record` refuses - the payment exists but its answer cannot be stored. */
  recordFailing = false;
  /** Only `release` refuses - the handler failed *and* Redis is going down. */
  releaseFailing = false;
  /** What `claim` answers. */
  claimResult: IdempotencyClaim = { kind: 'claimed' };

  async claim(scope: IdempotencyScope): Promise<IdempotencyClaim> {
    this.claims.push(scope);
    this.guard();

    return this.claimResult;
  }

  async record(scope: IdempotencyScope, record: IdempotencyRecord): Promise<void> {
    if (this.recordFailing) {
      throw new IdempotencyStoreUnavailableError();
    }

    this.guard();
    this.records.push(record);
  }

  async release(scope: IdempotencyScope): Promise<void> {
    if (this.releaseFailing) {
      throw new IdempotencyStoreUnavailableError();
    }

    this.guard();
    this.released.push(scope);
  }

  private guard(): void {
    if (this.failing) {
      throw new IdempotencyStoreUnavailableError();
    }
  }
}

/** The one line the interceptor reads out of configuration. */
function config(): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key !== 'idempotency.ttlSeconds') {
        throw new Error(`unexpected configuration read: ${key}`);
      }

      return IDEMPOTENCY_TTL_SECONDS;
    },
  } as unknown as ConfigService;
}

interface HarnessOptions {
  /** `null` means "no authenticated user", which is a wiring mistake. */
  userId?: string | null;
  /** `undefined` means "no `Idempotency-Key` header". */
  key?: string;
  body?: unknown;
  /** The handler: a value, or the error it throws. */
  failure?: unknown;
}

/**
 * One request, wired the way Nest wires it: `request.user` set by the guard, the body as the
 * parser left it, and `next.handle()` as the handler (a value, or the error it raised).
 */
function harness(options: HarnessOptions = {}) {
  const response = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string): void {
      this.headers[name] = value;
    },
  };

  const headers: Record<string, string> = {};
  const clientKey = 'key' in options ? options.key : CLIENT_KEY;

  if (clientKey !== undefined) {
    headers['idempotency-key'] = clientKey;
  }

  const request = {
    method: 'POST',
    path: '/v1/payments',
    headers,
    body: options.body ?? BODY,
    user: options.userId === null ? undefined : { ...CALLER, id: options.userId ?? CALLER.id },
  };

  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;

  const next: CallHandler = {
    handle: () => (options.failure === undefined ? of(BODY) : throwError(() => options.failure)),
  };

  const store = new FakeStore();

  return {
    store,
    context,
    next,
    response,
    interceptor: new IdempotencyInterceptor(store as unknown as RedisIdempotencyStore, config()),
  };
}

/** Runs one request through the interceptor, as Nest does. */
async function run(harnessed: ReturnType<typeof harness>): Promise<unknown> {
  return lastValueFrom(await harnessed.interceptor.intercept(harnessed.context, harnessed.next));
}
describe('a request that has not been seen', () => {
  it('claims the key, runs the handler, and stores the response against the claim', async () => {
    const harnessed = harness();

    await expect(run(harnessed)).resolves.toEqual(BODY);

    expect(harnessed.store.claims).toEqual([
      { route: 'POST /v1/payments', userId: CALLER.id, key: CLIENT_KEY },
    ]);
    // The body is stored *with* the hash of the request that produced it, which is what lets a
    // later request with the same key and a different body be refused rather than replayed.
    expect(harnessed.store.records).toHaveLength(1);
    expect(harnessed.store.records[0]?.body).toEqual(BODY);
    expect(harnessed.store.records[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing is released: the key now carries an answer.
    expect(harnessed.store.released).toEqual([]);
    expect(harnessed.response.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
  });

  it('scopes the claim to the caller and the route as well as the key', async () => {
    const harnessed = harness({ userId: 'another-user' });

    await run(harnessed);

    expect(harnessed.store.claims[0]).toEqual({
      route: 'POST /v1/payments',
      userId: 'another-user',
      key: CLIENT_KEY,
    });
  });
});

describe('a duplicate', () => {
  it('answers a completed request from the store, without running the handler', async () => {
    const harnessed = harness();
    harnessed.store.claimResult = {
      kind: 'taken',
      record: { requestHash: hashRequestBody(BODY), body: { id: 'the-original-transaction' } },
    };

    await expect(run(harnessed)).resolves.toEqual({ id: 'the-original-transaction' });

    // The marker is what tells the client "this payment already existed": the body is the
    // original response, so a client cannot tell the two apart any other way.
    expect(harnessed.response.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(harnessed.store.records).toEqual([]);
  });

  it('refuses a duplicate that is still in flight, and writes nothing', async () => {
    const harnessed = harness();
    harnessed.store.claimResult = { kind: 'taken', record: { requestHash: hashRequestBody(BODY) } };

    await expect(run(harnessed)).rejects.toBeInstanceOf(ConflictException);

    expect(harnessed.store.records).toEqual([]);
  });

  it('refuses the same key with a different body rather than replaying the first answer', async () => {
    const harnessed = harness({ body: { ...BODY, amount: '9999' } });
    harnessed.store.claimResult = {
      kind: 'taken',
      record: { requestHash: hashRequestBody(BODY), body: { id: 'the-original-transaction' } },
    };

    // The stored hash is of a different body, so this is not a retry of that request: replaying
    // it would tell the client a payment happened that it did not ask for.
    await expect(run(harnessed)).rejects.toBeInstanceOf(BadRequestException);
    expect(harnessed.response.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
  });
});
describe('a key that cannot be used', () => {
  it('refuses a missing Idempotency-Key before anything is written', async () => {
    const harnessed = harness({ key: undefined });

    await expect(run(harnessed)).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was claimed, so the request left no claim to expire and no record to replay.
    expect(harnessed.store.claims).toEqual([]);
  });

  it('refuses a key that is too short, or carries characters a Redis key should not', async () => {
    for (const key of ['short', 'has a space in it', 'semi;colon<key>', 'a'.repeat(256)]) {
      const harnessed = harness({ key });

      await expect(run(harnessed)).rejects.toBeInstanceOf(BadRequestException);
      expect(harnessed.store.claims).toEqual([]);
    }
  });

  it('accepts a key at both ends of the documented range', async () => {
    for (const key of ['12345678', 'a'.repeat(255)]) {
      await expect(run(harness({ key }))).resolves.toEqual(BODY);
    }
  });

  it('refuses a request with no authenticated user, so one caller cannot replay another', async () => {
    const harnessed = harness({ userId: null });

    await expect(run(harnessed)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harnessed.store.claims).toEqual([]);
  });
});

describe('when the handler fails', () => {
  it('gives the key back and lets the failure keep its status', async () => {
    const failure = new ConflictException('Not enough USDC in this wallet for that payment.');
    const harnessed = harness({ failure });

    await expect(run(harnessed)).rejects.toBe(failure);
    // Released, so the client's fix for the problem can be sent with the same key.
    expect(harnessed.store.released).toEqual([
      { route: 'POST /v1/payments', userId: CALLER.id, key: CLIENT_KEY },
    ]);
    expect(harnessed.store.records).toEqual([]);
  });

  it('still reports the handler failure when the release also fails', async () => {
    const failure = new BadRequestException('the handler refused');
    const harnessed = harness({ failure });
    harnessed.store.releaseFailing = true;

    // The caller's answer is what the handler raised: a Redis that is going down must not turn a
    // 400 into a 500, and the claim expires on its own either way.
    await expect(run(harnessed)).rejects.toBe(failure);
  });
});

describe('when the store misbehaves', () => {
  it('refuses the request when the key cannot be claimed, rather than running it', async () => {
    const harnessed = harness();
    harnessed.store.failing = true;

    // Fail closed: an unreadable claim is a duplicate that cannot be detected, and the one wrong
    // guess is "assume nobody has used this key".
    await expect(run(harnessed)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers the client anyway when the response cannot be stored, and releases the claim', async () => {
    const harnessed = harness();
    harnessed.store.recordFailing = true;

    // The payment exists by this point, so a 5xx would say otherwise. The claim is released
    // instead: a retry reaches the database, whose unique index answers "this key already created
    // a payment" - which is true - rather than the store pretending it never happened.
    await expect(run(harnessed)).resolves.toEqual(BODY);
    expect(harnessed.store.released).toHaveLength(1);
  });
});
