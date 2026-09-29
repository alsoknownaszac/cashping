import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/http/swagger.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyInterceptor,
} from '../../common/interceptors/idempotency.interceptor.js';
import { CurrentUser } from '../../identity/jwt/current-user.decorator.js';
import { JwtAuthGuard } from '../../identity/jwt/jwt-auth.guard.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { CreatePaymentDto } from '../dto/create-payment.dto.js';
import { PaymentCreatedResponseDto } from '../dto/payment-created-response.dto.js';
import { PaymentsService } from '../services/payments.service.js';

/**
 * `POST /v1/payments` (Step 25): create a payment. *Not* send one.
 *
 * The route exists in this shape - accepted, idempotent, `PENDING` - because that is what the
 * rest of the system can honestly do today. The row is written and the amount is reserved
 * against the sender's balance; whether Stellar accepts it is Day 4's question (Steps 27-29),
 * and answering 202 rather than 201 is exactly that statement: the request has been *taken*, and
 * the payment has a life ahead of it. A 201 with a body saying `PENDING` would read as "done".
 *
 * ## Two enhancers, for two different questions
 *
 * `JwtAuthGuard` answers *who is this*, and `IdempotencyInterceptor` answers *have I seen this
 * request*. Guards always run before interceptors, which is what the interceptor needs: a key
 * belongs to a caller, and the claim is scoped per caller so one client's key cannot replay
 * another's request. Declared the other way round the order would not change - which is why the
 * order here is a reading order and not a mechanism - but the interceptor's dependence on
 * `request.user` is real, and it fails closed (a 401) if it ever runs without a user.
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
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a payment (accepted for submission)',
    description: [
      'Writes a `PENDING` transaction and reserves its amount against the sender, then answers `202` with the transaction id. Nothing is sent to Stellar yet - Day 4 submits it (Steps 27-29).',
      '',
      "`amount` is read by the server, in full: the sender's wallet balance comes from Horizon, the amount already committed by in-flight payments is summed from the ledger table, and a payment that cannot be covered is refused with a 409. A client-computed total is not read, and cannot be sent.",
      '',
      '**This endpoint is idempotent.** Send a unique `Idempotency-Key` with each payment and reuse it for every retry of that payment: the first request writes the transaction, and any later request with the same key and the same body receives that transaction again (with `Idempotency-Replayed: true`) instead of creating a second one. A request with the same key while the first is still running is a 409, and the same key with a different body is a 400.',
    ].join('\n'),
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
    { status: 403, description: 'The account is suspended.' },
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
}
