import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';
import { MONEY_DECIMAL_PLACES, MONEY_INTEGER_DIGITS } from '../../common/money/amount.js';

/**
 * The body of `POST /v1/payments` (Step 25).
 *
 * Two fields, and the second one is a *string* - which is the money rule at the edge, not a
 * style choice. `amount: string` is the only shape that can carry a 7-decimal value without
 * a JS `number` rounding it on the way in (`Number('123456789012.1234567')` is
 * `123456789012.12346`), and it is what `Amount.fromString` reads. There is no `number`
 * variant and no coercion: a client that sends `25.5` as a JSON number gets a 400 naming the
 * field, because the alternative - accepting it - means accepting whatever their formatter
 * produced, which is exactly how a seventh decimal disappears.
 *
 * ## There is no `total`, and the client's arithmetic is not read (or accepted)
 *
 * Step 25 says to validate the amount server-side and ignore any client-computed total, and
 * this DTO is where that is enforced: the only money field in it is `amount`, the value is
 * parsed here and nowhere else, and a body carrying `total` (or `fee`, or `subtotal`) is
 * refused by the global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`)
 * rather than silently dropped. Refusing is the stronger version of "ignore": a request that
 * sends a total is a request built on an assumption this API does not share, and answering it
 * 202 while quietly using a different number is how a client ships a screen that shows a
 * figure the ledger never agreed to. `test/payments.e2e-spec.ts` asserts both halves - the
 * refusal, and that the amount that lands in the row is the server's own parse of `amount`.
 */
export class CreatePaymentDto {
  @ApiProperty({
    description:
      'The recipient, as an account id - from a search result, then confirmed with `GET /v1/recipients/:id`. A handle or a phone number is not accepted here: the confirmation step exists so a payment names the account a person checked.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  @IsUUID()
  recipientId!: string;

  @ApiProperty({
    description: [
      'How much to send, as a decimal string - never a JSON number.',
      '',
      `Plain digits with an optional point and at most ${MONEY_DECIMAL_PLACES} decimals (\`25\`, \`25.5\`, \`0.0000001\`), up to ${MONEY_INTEGER_DIGITS} integer digits, and strictly greater than zero.`,
      '',
      'Anything else is a 400 whose message names the reason: a leading `+`/`-`, exponent notation (`1e-7`), a thousands separator, whitespace, a trailing `.`, more decimals than the ledger can hold, or a value wider than the column.',
    ].join('\n'),
    example: '25.5',
    type: String,
  })
  @IsString()
  amount!: string;
}
