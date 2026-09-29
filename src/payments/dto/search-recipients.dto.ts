import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  RECIPIENT_SEARCH_DEFAULT_LIMIT,
  RECIPIENT_SEARCH_MAX_LIMIT,
} from '../recipients/recipient-query.js';

/**
 * Query of `GET /v1/recipients/search` (Step 21).
 *
 * `q` is one field rather than two (`phoneNumber` / `handle`) because that is what the person
 * on the other end has: one text field, and they type either a number or a name. Which one it
 * was is decided by `classifyRecipientQuery` - the Step 9 normalizer first, the handle rules
 * second - so the client never has to classify, and a client cannot get the classification
 * wrong in a way that would send a number down the handle path.
 *
 * `limit` is a ceiling on *handles* returned and is ignored on the phone path, which matches
 * at most one account. It exists because the prefix match is the enumerable half: without it,
 * `q=a` would return every handle containing an `a`.
 */
export class SearchRecipientsQueryDto {
  @ApiProperty({
    description: [
      'A phone number in any reasonable format (024 123 4567, +233241234567, 00233241234567) - matched exactly, never by prefix -',
      'or a handle with or without its @ (mir, @miriam_owusu), 3-20 characters of a-z, 0-9 and _, matched by prefix in lower case.',
      '',
      'A value that is not a valid phone number is read as a handle, so a mistyped number is not an error - it is a handle search that finds nothing.',
    ].join(' '),
    example: 'mir',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  // A ceiling, not a format rule - the same argument as `SubmittedPhoneNumberDto`: 64 characters
  // is more than any accepted spelling of a number or the longest possible handle plus an `@`,
  // and it stops a body-sized payload from being walked through the number parser.
  @MaxLength(64)
  q!: string;

  @ApiPropertyOptional({
    description: `How many handles to return, at most. Defaults to ${RECIPIENT_SEARCH_DEFAULT_LIMIT} and is capped at ${RECIPIENT_SEARCH_MAX_LIMIT}.`,
    example: RECIPIENT_SEARCH_DEFAULT_LIMIT,
    minimum: 1,
    maximum: RECIPIENT_SEARCH_MAX_LIMIT,
  })
  @IsOptional()
  // Query parameters arrive as strings, and `@IsInt()` needs a number to say anything useful
  // about them - left as `'10'` it would report "must be an integer number" for every value,
  // including the correct ones.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECIPIENT_SEARCH_MAX_LIMIT)
  limit?: number;
}
