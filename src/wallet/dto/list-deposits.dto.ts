import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { DEPOSITS_DEFAULT_LIMIT, DEPOSITS_MAX_LIMIT } from '../deposits/deposit-query.js';

/**
 * Query of `GET /v1/wallet/deposits`: how many, and where to resume.
 *
 * Both members are `string`s on the wire and every rule about them lives in
 * `deposits/deposit-query.ts`, exactly as `ListPaymentsQueryDto` does for the history filters.
 * That split is load-bearing rather than stylistic: `limit` is *clamped* rather than refused, so
 * the validation pipe must not be the thing that rejects `limit=1000` - a `@Max()` here and a
 * clamp there would be two statements of one bound, free to drift. The pipe's job is only to
 * ensure the values are strings; this module's job is to decide what they mean.
 *
 * There are no filters beyond these two, and that is a property of the source: Horizon's payments
 * query answers "everything paid into this account", newest first, and paging is the only useful
 * knob. A time window or an asset filter would be done on the client's side of a page, or it would
 * be a different query against a store this endpoint deliberately does not keep.
 */
export class ListDepositsQueryDto {
  @ApiPropertyOptional({
    description: `How many deposits to return, at most. Defaults to ${DEPOSITS_DEFAULT_LIMIT} and is clamped at ${DEPOSITS_MAX_LIMIT}; \`nextCursor\` in the response says whether there is another page.`,
    example: DEPOSITS_DEFAULT_LIMIT,
    type: String,
  })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description:
      'The `nextCursor` from a previous response, to fetch the page of older deposits after it. Omit it for the newest page.',
    example: '128849018880',
    type: String,
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
