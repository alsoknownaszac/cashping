import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `PATCH /v1/auth/handle`: the handle now in force.
 *
 * The canonical value is echoed back rather than nothing being said, because the request
 * may not have been written in the spelling the account now holds: an input of `@Miriam` is
 * stored as `miriam`, and a client that kept its own copy would be rendering a handle that
 * is not the one another user has to type. This is the same value `GET /v1/auth/session`
 * reports, so a client that stores it does not need a follow-up read.
 *
 * There is no timestamp here, and none is stored: unlike the PIN and the password - which
 * carry a `*SetAt` column precisely so "has one" and "when it was set" cannot disagree - a
 * handle has no such column, and the response reports the fact of the write rather than
 * inventing a field the row does not hold.
 */
export class HandleResponseDto {
  @ApiProperty({
    description: 'The handle now in force, canonical: lower-cased, with no leading `@`.',
    example: 'miriam_owusu',
  })
  handle!: string;
}
