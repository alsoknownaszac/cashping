import { ApiProperty } from '@nestjs/swagger';
import type { ErrorResponseBody } from '../filters/all-exceptions.filter.js';

/**
 * The body every failed request is answered with, published for the frontend so
 * it can render errors from one shape instead of guessing per endpoint.
 *
 * `implements ErrorResponseBody` is the point of this class: the filter's
 * interface stays the source of truth, and a field added there fails to compile
 * here until the documented shape is updated too.
 */
export class ErrorResponseDto implements ErrorResponseBody {
  @ApiProperty({
    description: 'HTTP status code of the failure.',
    example: 500,
  })
  statusCode!: number;

  @ApiProperty({
    description: 'Short reason phrase.',
    example: 'Internal Server Error',
  })
  error!: string;

  @ApiProperty({
    description:
      'Human-readable detail. A string for ordinary failures; an array of per-field messages when a request body failed validation.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Internal server error',
  })
  message!: string | string[];

  @ApiProperty({
    description: 'Path the request was made to, including the route prefix.',
    example: '/v1/health',
  })
  path!: string;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of when the failure was handled.',
    example: '2026-09-26T10:00:00.000Z',
  })
  timestamp!: string;
}
