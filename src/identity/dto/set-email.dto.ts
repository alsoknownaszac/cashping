import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { MAX_EMAIL_LENGTH } from '../email/email-address.js';

/**
 * Body of `POST /v1/auth/email` (Step 34c): attach (or replace) an address.
 *
 * Only a length ceiling is enforced here, deliberately - no `@IsEmail()`, and no regex
 * decorator. The shape rule lives in `normalizeEmailAddress` (`email-address.ts`) for the
 * same reason the handle's rules live in `assertHandleAllowed`: a decorator answers every
 * malformed address with the same 400 and no explanation, while the service can say *which*
 * rule was broken and echo back exactly what was sent. And the value this endpoint stores is
 * the *normalized* one, so the rule and the normalization have to be the same code rather
 * than two descriptions that drift.
 */
export class SetEmailDto {
  @ApiProperty({
    description: `The email address to attach to the account and verify. Stored lower-cased, so one mailbox is one value. At most ${MAX_EMAIL_LENGTH} characters.`,
    example: 'miriam@example.com',
    maxLength: MAX_EMAIL_LENGTH,
  })
  @IsString()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;
}
