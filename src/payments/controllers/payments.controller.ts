import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { StepUpAuthGuard } from '../../common/guards/step-up-auth.guard.js';
import { ApiErrorResponses } from '../../common/http/swagger.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyInterceptor,
} from '../../common/interceptors/idempotency.interceptor.js';
import { CurrentUser } from '../../identity/jwt/current-user.decorator.js';
import { JwtAuthGuard } from '../../identity/jwt/jwt-auth.guard.js';
import { STEP_UP_TOKEN_HEADER } from '../../identity/pin/step-up-token.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { CreatePaymentDto } from '../dto/create-payment.dto.js';
import { ListPaymentsQueryDto } from '../dto/list-payments.dto.js';
import { PaymentCreatedResponseDto } from '../dto/payment-created-response.dto.js';
import { PaymentListResponseDto } from '../dto/payment-list-response.dto.js';
import { PaymentResponseDto } from '../dto/payment-response.dto.js';
import { PaymentsService } from '../services/payments.service.js';

/**
 * Payments over HTTP: `POST /v1/payments` (Step 25) and the two reads (Step 30).
 *
 * `POST /v1/payments` *creates* a payment. *Not* sends one.
 *
 * ## The two reads, and the reason `@Get()` is declared before `@Get(':id')`
 *
 * `GET /v1/payments/:id` answers about one payment the caller is a party to, and `GET /v1/payments`
 * answers with a filtered page of the caller's own history. Both are guarded, and both delegate
 * everything to `PaymentsService`, which owns the scope (membership - the caller's id is part of
 * the query, never a parameter) and the status codes (400 for a filter that cannot be read, 404 for
 * a payment the caller is not a party to).
 *
 * The order below is the same trap `RecipientsController` records: Nest registers routes in
 * declaration order. `/payments/:id` does not shadow `/payments` today - the paths differ by a
 * segment - but the habit is the point. The day a literal sub-path is added (`/payments/summary`),
 * the route that reads like a filter declares first or it arrives as an `:id`, is refused by the
 * UUID pipe with a 400, and looks like a validation bug rather than a routing one.
 *
 * The route exists in this shape - accepted, idempotent, `PENDING` - because that is what the
 * rest of the system can honestly do today. The row is written and the amount is reserved
 * against the sender's balance; whether Stellar accepts it is Day 4's question (Steps 27-29),
 * and answering 202 rather than 201 is exactly that statement: the request has been *taken*, and
 * the payment has a life ahead of it. A 201 with a body saying `PENDING` would read as "done".
 *
 * ## Three enhancers, for three different questions
 *
 * `JwtAuthGuard` answers *who is this*, `StepUpAuthGuard` answers *was the second factor proved
 * just now* (Step 34a), and `IdempotencyInterceptor` answers *have I seen this request*. Guards
 * always run before interceptors, and guards run in the order they are listed, which is what the
 * other two need: a key belongs to a caller, and the claim is scoped per caller so one client's
 * key cannot replay another's request; and a step-up token names an account, so it can only be
 * compared against a caller that has already been established. The interceptor's dependence on
 * `request.user` is real, and it fails closed (a 401) if it ever runs without a user.
 *
 * Note what the interceptor does *not* answer any more: a replayed request still has to present a
 * fresh step-up token, because the replay path returns a stored response to a request that got as
 * far as the interceptor. A stored payment is not a licence to stop proving the PIN.
 *
 * ## The key is required, and the body has no total
 *
 * `Idempotency-Key` is documented as required and refused when missing (400), because a retry of
 * a payment must be safe and a client that may omit the key cannot know whether its retry was.
 * The body carries only `recipientId` and `amount`; see `CreatePaymentDto` for what happens to a
 * client-computed `total` (it is refused, which is the strong form of "ignored").
 *
 * ## What is deliberately not here
 *
 * No rate limit of its own: the lookup limit prices *searching the directory*
 * (`RecipientLookupRateLimiter`), and a payment is not a lookup. Step 33 sweeps every endpoint
 * for throttling and is where a payment-specific limit would be argued. No `@Res()` and no
 * manual status plumbing either - the interceptor replays a stored body and Nest applies this
 * route's `@HttpCode` to it, so both paths answer 202 without either of them writing a status.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, StepUpAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a payment (accepted for submission)',
    description: [
      'Writes a `PENDING` transaction and reserves its amount against the sender, then answers `202` with the transaction id. Nothing is sent to Stellar yet - Day 4 submits it (Steps 27-29).',
      '',
      '**Sending money needs the transaction PIN.** Besides the access token, the request must carry a fresh `X-Step-Up-Token`, which `POST /auth/pin/verify` answers with when the caller proves its four-digit PIN. A request without a usable one is refused with a 403 - the token was accepted, the second credential was not presented - and the refusal is recorded in the audit log. The token expires in five minutes; get another by proving the PIN again.',
      '',
      "`amount` is read by the server, in full: the sender's wallet balance comes from Horizon, the amount already committed by in-flight payments is summed from the ledger table, and a payment that cannot be covered is refused with a 409. A client-computed total is not read, and cannot be sent.",
      '',
      '**This endpoint is idempotent.** Send a unique `Idempotency-Key` with each payment and reuse it for every retry of that payment: the first request writes the transaction, and any later request with the same key and the same body receives that transaction again (with `Idempotency-Replayed: true`) instead of creating a second one. A request with the same key while the first is still running is a 409, and the same key with a different body is a 400. A retry needs a fresh step-up token like any other request - a stored response is not a way around the PIN.',
    ].join('\n'),
  })
  @ApiHeader({
    name: STEP_UP_TOKEN_HEADER,
    required: true,
    description: [
      'The step-up token from `POST /auth/pin/verify`, proving the transaction PIN has just been given. It is valid for five minutes, and it belongs to one account: a token minted for somebody else is refused like a forged one.',
      '',
      'Header names are case-insensitive, so `X-Step-Up-Token` and `x-step-up-token` are the same header. It is deliberately *not* sent in the body: a credential in a body would be payment data, which the idempotency store keeps a copy of and a request log may print.',
    ].join('\n'),
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: [
      'A unique string per payment, 8-255 characters of letters, digits, `-`, `_`, `.`, `~` or `+`. Reuse it *only* for retries of the same request: it identifies that payment, and repeating it returns the original response instead of creating a second transaction.',
      '',
      'A UUID is the obvious choice. Header names are case-insensitive, so `Idempotency-Key` and `idempotency-key` are the same header.',
    ].join('\n'),
    example: 'b2d3f4a5-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
  })
  @ApiAcceptedResponse({
    type: PaymentCreatedResponseDto,
    description: [
      'The transaction was written and its amount is reserved against the sender.',
      '',
      `A response carrying \`${IDEMPOTENCY_REPLAYED_HEADER}: true\` is the *stored* answer to an earlier request with the same key - the same body, so the same transaction id, and no second payment.`,
    ].join('\n'),
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The body is not the documented shape (a `total` or any other undeclared field is refused), `amount` is not an amount the ledger can hold (a sign, exponent notation, a thousands separator, more than 7 decimals, wider than the column, or zero), the recipient is the sender, the wallet cannot hold USDC yet, or the `Idempotency-Key` header is missing, malformed, or has been used for a different request.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    {
      status: 403,
      description: [
        'One of two refusals, and the message says which.',
        '',
        'The account is suspended, so nothing may be done with it until support lifts it.',
        '',
        'Or the transaction PIN has not been proved recently, and no fresh step-up token was presented. Call `POST /auth/pin/verify`, then retry with its token in `X-Step-Up-Token`. This is a 403 rather than a 401 because the access token *was* accepted - the caller is signed in and has simply not presented the second factor - and the refusal is written to the audit log with the outcome `denied`.',
      ].join('\n'),
    },
    {
      status: 404,
      description:
        'The sender has no Stellar account yet, or the recipient is not an account that can receive money - unknown, unverified and suspended are all one sentence, so the endpoint cannot be asked which ids exist.',
    },
    {
      status: 409,
      description:
        'The wallet cannot cover this payment (the message carries the spendable amount), a request with this idempotency key is already in flight, or the key already created a payment whose response could not be replayed. The payment was not created in any of those cases.',
    },
    {
      status: 503,
      description:
        'The idempotency key could not be evaluated (Redis unreachable) or the wallet balance could not be read (Horizon unreachable), so the request was refused rather than run uncounted or against an unknown balance. Retry shortly.',
    },
  ])
  create(
    @CurrentUser() user: SessionUser,
    @Body() body: CreatePaymentDto,
    /**
     * Read straight from the header here, and *trusted*: `IdempotencyInterceptor` has already
     * refused the request if it were missing or malformed. Typing it as `string` rather than
     * `string | undefined` is that promise, kept one layer up - and the e2e exercises the
     * refusal, so the invariant is tested where it is enforced rather than assumed here.
     */
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string,
  ): Promise<PaymentCreatedResponseDto> {
    return this.payments.create(user, body, idempotencyKey);
  }

  /**
   * `GET /v1/payments` (Step 30): the caller's own history, newest first.
   *
   * Declared before `:id` on purpose - see the class docblock. One delegation, like every other
   * handler here: `PaymentsService.history` reads the query, owns the scope, and answers.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List your payments, newest first',
    description: [
      'Every payment this account is a party to - sent or received, one row each - newest first, with filters for the interesting questions a support conversation asks: "what did I send last week", "what is still processing", "what failed".',
      '',
      'The scope is not a parameter. There is no way to ask this endpoint for somebody else\'s history: the caller is part of the query, and `direction` chooses only which side of *their own* payments to read.',
      '',
      '`hasMore` says whether the filters matched more than this page holds, and it is computed from the same read that produced `items` rather than from a second count - so the page and its answer cannot disagree.',
      '',
      'The two fields that only make sense while looking at one payment, `failureReason` and `stellarTxHash`, are on `GET /v1/payments/:id` and deliberately absent here.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: PaymentListResponseDto,
    description:
      'The caller\'s payments that matched, newest first. An empty `items` is an ordinary answer: "nothing matched", not a 404.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'A filter could not be read: `direction` is not `sent`/`received`/`both`, `status` is not one of the four statuses, `from` or `to` is not an ISO-8601 instant, `limit` is not a whole number, or `from` is later than `to`. The message names the parameter and the values that work.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
  ])
  list(
    @CurrentUser() user: SessionUser,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentListResponseDto> {
    return this.payments.history(user.id, query);
  }

  /**
   * `GET /v1/payments/:id` (Step 30): one payment, if the caller is a party to it.
   *
   * The id is the value `POST /v1/payments` answered with - the thing a client polls after being
   * told `202`, and the thing a support conversation is keyed on.
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'One of your payments, by id',
    description: [
      'The row as it stands now: `PENDING` while nothing has been submitted, `PROCESSING` while a signed transaction is with the network, then `SUCCESSFUL` or `FAILED` when a ledger has closed it. `SUCCESSFUL` and `FAILED` are final.',
      '',
      'Both parties to a payment can read it with the same id - the sender sees `direction: sent`, the recipient sees `received` - and nobody else can: a payment the caller is not a party to answers exactly what a made-up id answers (404), so this route cannot be used to discover which payment ids exist.',
      '',
      '`failureReason` is the raw machine code the submission path recorded, never Horizon\'s prose, and it is only meaningful while `status` is `FAILED`. `stellarTxHash` is the hash to paste into an explorer, and it can be present on a `FAILED` row: a transaction a ledger closed unsuccessfully is still a transaction.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description: 'The transaction id - the value `POST /v1/payments` returned.',
    example: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
  })
  @ApiOkResponse({
    type: PaymentResponseDto,
    description: 'The payment, as the caller sees it.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description: '`id` is not a UUID, so it cannot be a transaction id.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 404,
      description:
        'No payment with that id involves this account: it does not exist, or it belongs to two other people. The two are one answer, deliberately.',
    },
  ])
  findOne(
    @CurrentUser() user: SessionUser,
    // The pipe is what turns "not a UUID" into a 400 rather than into a 404 from the database: an
    // id that cannot be an id is a malformed request, and the two mean different things to a client
    // (fix the request, versus stop looking). The same choice `RecipientsController.confirm` makes.
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PaymentResponseDto> {
    return this.payments.findOne(user.id, id);
  }
}
