import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, catchError, from, mergeMap, of } from 'rxjs';
import { type SessionUser } from '../../identity/token/token.service.js';
import {
  IdempotencyStoreUnavailableError,
  RedisIdempotencyStore,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type IdempotencyScope,
} from './idempotency-store.js';

/**
 * Where the client sends its key.
 *
 * Lower case because Node's HTTP parser lower-cases every incoming header name, so this is the
 * form the lookup uses; the *documented* spelling is `Idempotency-Key`, which is what a client
 * should send (header names are case-insensitive). One constant, used by the interceptor that
 * reads it and by the controller that documents and forwards it.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The header a replayed response carries, so a client can tell "I made this payment"
 * from "the payment I made earlier". Absent on a fresh response rather than `false`,
 * because the interesting state is the replay and an absent header cannot be mistaken
 * for a value someone forgot to update.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

/**
 * What a client key may look like: 8 to 255 characters of URL-safe ASCII.
 *
 * Bounded because the value becomes part of a Redis key (an unbounded one is a memory
 * and a log-injection question), and restricted to characters that survive a header, a
 * proxy and a Redis CLI. 8 is below any real generator's output (a UUID is 36) and 255
 * is the limit Stripe documents, chosen because a client that already has an
 * idempotency key from elsewhere can keep using it.
 */
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._~+-]{8,255}$/;

/** One message for every way the store can be unavailable, at the HTTP edge. */
const IDEMPOTENCY_UNAVAILABLE =
  'Payments are temporarily unavailable. Please try again in a moment.';

/** The request as the guard leaves it, plus the field this interceptor reads. */
interface IdempotentRequest extends Request {
  user?: SessionUser;
}

/**
 * Step 24: a payment-creation request runs once per key, and its duplicate gets the
 * first request's answer.
 *
 * ## What "idempotent" has to mean for money
 *
 * A client on a flaky connection retries. Without this, the retry is a *second
 * payment*: the first attempt succeeded, its response was lost, and the client has no
 * way to ask "did that go through?" - so it asks again by sending again. The fix is an
 * `Idempotency-Key` the client generates and reuses for the retry, and the rule this
 * interceptor enforces is:
 *
 * - the first request with a key claims it, runs, and stores its response body;
 * - a later request with the same key and the same body gets that stored body back -
 *   the same transaction id, not a second transaction;
 * - a request with that key *while the first is still running* gets a 409, because the
 *   honest answer is "not yet", and inventing one would have the client act on a
 *   payment that may not exist;
 * - a request with the same key and a *different* body gets a 400: the key names a
 *   request, so reusing it for another one is a client bug, and replaying the first
 *   answer would tell the client a payment happened that it did not ask for.
 *
 * ## Two layers, and why both
 *
 * The claim in Redis (see `RedisIdempotencyStore`) is what makes the *answer* right: it
 * is the only place the first response is remembered. It is not what makes the row count
 * right. That is `@@unique([senderId, idempotencyKey])` on `transactions`, checked by the
 * database at insert time, and it holds when Redis does not: a claim that expired, a
 * Redis flush, an instance that never saw the key, or a bug in this file all end at the
 * same constraint, and the service turns that violation into a 409 rather than a 500.
 * The e2e for this step asserts the *row count* after a duplicate, which is the only
 * claim worth making - a replayed response is a convenience, one row is the guarantee.
 *
 * ## Fail closed, and what that costs
 *
 * Redis unreachable means the key cannot be evaluated, so the request is refused with a
 * 503 - the same decision `RecipientLookupRateLimiter` records, for a stronger reason: an
 * unreadable lookup counter means an uncounted sweep, while an unreadable key means a
 * payment whose duplicate cannot be detected. The cost is real (a Redis blip stops
 * payments, even though the database alone would have been enough) and accepted: the
 * alternative is deciding, under load and without information, which of two identical
 * requests is the duplicate.
 *
 * ## What this deliberately does not do
 *
 * It is not applied globally, and it does not replace a rate limit: it is on the routes
 * that create money (`POST /v1/payments` today, the submission endpoints later), applied
 * with `@UseInterceptors` exactly as `JwtAuthGuard` is applied per route. A global
 * interceptor would also claim keys for reads, where the stored "response" is one user's
 * data and replaying it is a disclosure question - the scoping below is what makes a
 * record safe to replay, and a read has nothing to make idempotent.
 *
 * The status code is not part of the record: a replayed body goes back through the same
 * route, so Nest applies that route's own `@HttpCode` (202 on `POST /v1/payments`) to it,
 * and the e2e asserts the replay's status rather than trusting either path. Storing it
 * would be a second source of truth for something the route already decides.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly store: RedisIdempotencyStore,
    private readonly config: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const scope: IdempotencyScope = {
      route: `${request.method} ${request.path}`,
      userId: this.callerOf(request),
      key: this.clientKeyOf(request),
    };

    const requestHash = hashRequestBody(request.body);
    const ttlSeconds = this.config.getOrThrow<number>('idempotency.ttlSeconds');

    const claim = await this.claim(scope, requestHash, ttlSeconds);

    if (claim.kind === 'taken') {
      return this.answerWith(claim.record, requestHash, response);
    }

    return next.handle().pipe(
      /**
       * `mergeMap` rather than `map`, because storing the response is an await and the
       * body must reach the client only once it is stored: a response the store never saw
       * is a response a retry cannot be answered with.
       */
      mergeMap(async (body: unknown) => {
        await this.finish(scope, requestHash, body, ttlSeconds);

        return body;
      }),
      /**
       * The handler failed, so nothing was created and the key is given back: a refused
       * payment (no balance, no such recipient, a malformed amount) has to be retryable
       * with the same key, or the client cannot send the fix it just made.
       */
      catchError((error: unknown) => from(this.abandon(scope, error))),
    );
  }

  /**
   * The claimed key, or a 503.
   *
   * A store failure is translated here rather than inside the store: the store's error
   * vocabulary is about Redis, and what a client needs to hear is that the request was
   * refused because the key could not be checked.
   */
  private async claim(
    scope: IdempotencyScope,
    requestHash: string,
    ttlSeconds: number,
  ): Promise<IdempotencyClaim> {
    try {
      return await this.store.claim(scope, requestHash, ttlSeconds);
    } catch (error) {
      throw asHttp(error);
    }
  }

  /** A stored record, as the response the client should have received the first time. */
  private answerWith(
    record: IdempotencyRecord,
    requestHash: string,
    response: Response,
  ): Observable<unknown> {
    if (record.requestHash !== requestHash) {
      throw new BadRequestException(
        'This Idempotency-Key was used for a different request. Use a new key for a different payment.',
      );
    }

    if (record.body === undefined) {
      throw new ConflictException(
        "A request with this Idempotency-Key is already in flight. Wait for it to finish - it answers with that request's result - then try again.",
      );
    }

    response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');

    return of(record.body);
  }

  /**
   * Stores the response, and never fails the request it is answering.
   *
   * The payment exists by the time this runs, so a 5xx here would tell a client that a
   * payment it made did not happen. Instead the claim is released: a retry then reaches
   * the database, whose unique index answers "this key already created a payment" (a 409
   * from `PaymentsService`) rather than pretending nothing was written. The log line is
   * the operator's signal - a store that cannot be written is a Redis problem, and the
   * response and the row agree either way.
   */
  private async finish(
    scope: IdempotencyScope,
    requestHash: string,
    body: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.store.record(scope, { requestHash, body }, ttlSeconds);
    } catch (error) {
      this.logger.error(
        `Idempotency result for ${scope.route} could not be stored - releasing the claim`,
        error instanceof Error ? error.stack : String(error),
      );

      await this.forget(scope);
    }
  }

  /**
   * Gives the key back after the handler failed, and rethrows what the handler threw.
   *
   * The handler's failure is the caller's answer and must keep its status; a release that
   * fails is logged and dropped, because the claim expires on its own and a client that
   * retries after the TTL gets a fresh attempt either way.
   */
  private async abandon(scope: IdempotencyScope, error: unknown): Promise<never> {
    await this.forget(scope);

    throw error;
  }

  /** Best-effort `release`: logged, never thrown. */
  private async forget(scope: IdempotencyScope): Promise<void> {
    try {
      await this.store.release(scope);
    } catch (error) {
      this.logger.warn(
        `Idempotency claim for ${scope.route} was not released: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The signed-in user, as the guard left them; a missing one is a wiring mistake. */
  private callerOf(request: IdempotentRequest): string {
    if (request.user === undefined) {
      /**
       * Only reachable by applying this interceptor to a route without `JwtAuthGuard` -
       * the same mistake, and the same answer, as `@CurrentUser`'s: fail as loudly as a
       * missing token rather than key a claim on an undefined caller, which would let one
       * request replay another's.
       */
      throw new UnauthorizedException('Invalid or expired access token. Sign in again.');
    }

    return request.user.id;
  }

  /**
   * The client's key, or a 400.
   *
   * Required rather than optional. A money endpoint that accepts a retry-safe request
   * *sometimes* is one whose client cannot know whether its retry was safe, so the key is
   * part of the contract, documented as `@ApiHeader({ required: true })`, and its absence
   * is refused before anything is written. The lookup is lower case because Node's HTTP
   * parser lower-cases every incoming header name; the documented spelling is
   * `Idempotency-Key`, which is what a client should send.
   */
  private clientKeyOf(request: IdempotentRequest): string {
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    const value = Array.isArray(header) ? header[0] : header;

    if (value === undefined || value === '') {
      throw new BadRequestException(
        'This endpoint requires an `Idempotency-Key` header: a unique string per payment, reused when retrying it.',
      );
    }

    if (!CLIENT_KEY_PATTERN.test(value)) {
      throw new BadRequestException(
        '`Idempotency-Key` must be 8 to 255 characters of letters, digits, `-`, `_`, `.`, `~` or `+`.',
      );
    }

    return value;
  }
}

/**
 * What the store's failure means over HTTP.
 *
 * `IdempotencyStoreUnavailableError` becomes the 503 a client can retry; anything else is
 * a bug in this file and keeps travelling to the global filter, where Sentry sees it.
 */
function asHttp(error: unknown): unknown {
  return error instanceof IdempotencyStoreUnavailableError
    ? new ServiceUnavailableException(IDEMPOTENCY_UNAVAILABLE)
    : error;
}

/**
 * The request body, as one hex digest.
 *
 * Exported because the tests have to build a *matching* stored record, and computing the digest a
 * second way in the spec would let the two drift: a replay test that hashes differently from the
 * interceptor would fail as a 400, not as a replay, and the spec would be testing its own
 * duplicate of the rule instead of this one.
 *
 * `JSON.stringify` of the parsed body, not of a re-serialised DTO: what is compared is what the
 * client sent. A key therefore names a *request*, byte for byte - a client that reorders its JSON
 * between retries gets a 400 rather than a replay, which is the conservative direction (it is
 * told its request was not understood as the same one), and the fix is the one an idempotency key
 * asks for anyway: send the same request.
 */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}
