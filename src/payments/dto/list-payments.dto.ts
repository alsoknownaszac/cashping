import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import {
  PAYMENT_HISTORY_DEFAULT_LIMIT,
  PAYMENT_HISTORY_DIRECTIONS,
  PAYMENT_HISTORY_MAX_LIMIT,
} from '../history/payment-history-query.js';

/**
 * Query of `GET /v1/payments` (Step 30): the history filters, newest first.
 *
 * ## This DTO declares the fields; the query module decides what they mean
 *
 * Every member is a `string` here and every rule about it lives in
 * `history/payment-history-query.ts`. That is the split Step 21 established with
 * `classifyRecipientQuery`, and here it is load-bearing rather than stylistic: `limit` is
 * *clamped* rather than refused, so the validation pipe must not be the thing that rejects
 * `limit=1000` - and a `@Max()` here plus a clamp there would be two statements of one bound, free
 * to drift. `limit` is therefore a string on the wire, parsed by the module, and **not** a
 * `@Type(() => Number)` field: a pipe that coerced and refused would take half the parsing away
 * from the code whose spec tests it.
 *
 * ## What each value accepts
 *
 * | Parameter | Values | Default |
 * | --- | --- | --- |
 * | `direction` | `sent`, `received`, `both` | `both` |
 * | `status` | `PENDING`, `PROCESSING`, `SUCCESSFUL`, `FAILED` | no filter |
 * | `from` / `to` | ISO-8601 instants; both bounds **inclusive** on `createdAt` | no bound |
 * | `limit` | a whole number of payments, clamped to `[1, ${PAYMENT_HISTORY_MAX_LIMIT}]` | `${PAYMENT_HISTORY_DEFAULT_LIMIT}` |
 *
 * A value that is not in a list is a 400 naming the parameter and the values that work. A
 * `direction` or `status` sent *empty* means "not provided" - "no filter" is a real request, and
 * an always-appended key with nothing in it is how a client spells it - while an empty `from`,
 * `to` or `limit` is refused, because each names a specific value and the empty string is not one.
 *
 * A date-only `from`/`to` is midnight UTC of that day and nothing else. `to=2026-09-30` therefore
 * means `<= 2026-09-30T00:00:00.000Z`: a client that wants the whole of the 30th passes
 * `to=2026-09-30T23:59:59.999Z`, because silently widening a bound to the end of its day is a
 * hidden `+23:59:59.999` in a filter a person is reading numbers out of.
 */
export class ListPaymentsQueryDto {
  @ApiPropertyOptional({
    description:
      'Which side of the history to read. `sent` is money this account paid out, `received` is money paid to it, and `both` (the default) is every payment it is a party to - each row appearing once, with `direction` saying which side it is on for the caller.',
    enum: PAYMENT_HISTORY_DIRECTIONS,
    example: 'both',
  })
  @IsOptional()
  @IsString()
  direction?: string;

  @ApiPropertyOptional({
    description: `Only payments in this state. Omit for all four.`,
    enum: Object.values(TransactionStatus),
    example: 'SUCCESSFUL',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description:
      'The earliest `createdAt` to include, inclusive, as an ISO-8601 instant. A date on its own is midnight UTC of that day.',
    example: '2026-09-01T00:00:00.000Z',
    type: String,
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
    description:
      'The latest `createdAt` to include, inclusive, as an ISO-8601 instant. A date on its own is midnight UTC of that day, so `2026-09-30` includes nothing that happened during the 30th.',
    example: '2026-09-30T23:59:59.999Z',
    type: String,
  })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({
    description: `How many payments to return, at most. Defaults to ${PAYMENT_HISTORY_DEFAULT_LIMIT} and is clamped at ${PAYMENT_HISTORY_MAX_LIMIT}; \`hasMore\` in the response says whether the page was cut short.`,
    example: PAYMENT_HISTORY_DEFAULT_LIMIT,
    type: String,
  })
  @IsOptional()
  @IsString()
  limit?: string;
}
