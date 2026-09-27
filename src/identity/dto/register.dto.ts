import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from '../handle/handle.js';
import { SubmittedPhoneNumberDto } from './phone-number.dto.js';

/**
 * Body of `POST /v1/auth/register` (Step 10, extended in Step 15).
 *
 * `phoneNumber` comes from `SubmittedPhoneNumberDto`: the *raw* submission, not
 * E.164, because the endpoint's contract is "any reasonable format" and
 * `configuration.ts`'s `phone.defaultRegion` decides how a local spelling is read.
 * The normalizer (Step 9) runs before anything touches the database, so this class
 * adds one thing to it.
 *
 * `handle` is that thing, and the split is worth being explicit about: the only rule
 * enforced here is the ceiling (a body that is really a payload never reaches the
 * handle parser), while the real policy - normalization, length, characters, reserved
 * words, availability - lives in `assertHandleAllowed` and `AuthService`, where a
 * failure can carry a *reason* and its own status code. A `@Matches` decorator here
 * would answer every one of those cases with the same 400 and no explanation of which
 * rule was broken.
 */
export class RegisterDto extends SubmittedPhoneNumberDto {
  @ApiPropertyOptional({
    description: `The handle to claim, with or without the leading @. ${HANDLE_MIN_LENGTH}-${HANDLE_MAX_LENGTH} characters from a-z, 0-9 and _, stored in lower case so @Miriam and @miriam are the same handle. Reserved words (admin, support, cashping and their variants) are refused.`,
    example: '@miriam_owusu',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  handle?: string;
}
