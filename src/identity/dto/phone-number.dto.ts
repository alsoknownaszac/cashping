import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The ceiling every `phoneNumber` field agrees on.
 *
 * A ceiling, not a format rule: 32 characters is comfortably more than the longest way any of
 * the accepted formats writes a 15-digit number, and it stops a body that is really a payload
 * from being walked character by character through the phone number parser.
 */
export const PHONE_NUMBER_MAX_LENGTH = 32;

/** What the field is, said once, so the two spellings of it below cannot describe it two ways. */
const PHONE_NUMBER_DESCRIPTION =
  'The phone number, in any reasonable format: local (024 123 4567), international with a plus (+233241234567), with the national prefix (+2330241234567) or with 00 (00233241234567). Stored and matched as E.164.';

/**
 * A phone number as submitted, and the one definition of what that means
 * (Step 16).
 *
 * `RegisterDto` and `VerifyOtpDto` extend this class, and `POST /auth/login/otp`
 * takes it directly - an endpoint whose body is nothing but a phone number, so it has
 * no schema of its own to name. The field is declared once rather than copied per
 * endpoint because a copy is exactly where the rules drift: one endpoint's ceiling is
 * raised, another keeps the old one, and the result is a 400 that happens only for
 * the longest spelling of a number the other endpoint accepts.
 *
 * The subclasses are also what gives each endpoint its own schema in the OpenAPI
 * document, which is why they are classes rather than a type alias.
 *
 * One endpoint needs the same field *optional* rather than required - a password sign-in carries
 * a number or an address (Step 34c) - and required-ness is a decorator, so it cannot be inherited
 * away. That is what the second class below is, and why both spellings live in one file.
 */
export class SubmittedPhoneNumberDto {
  @ApiProperty({
    description: PHONE_NUMBER_DESCRIPTION,
    example: '024 123 4567',
    maxLength: PHONE_NUMBER_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  // Validation that number-shaped text is not a `phoneNumber` is deliberately not
  // done here either: a regex in a decorator is the hand-rolled phone parsing
  // Step 9 exists to replace.
  @MaxLength(PHONE_NUMBER_MAX_LENGTH)
  phoneNumber!: string;
}

/**
 * The same field, optional: the identifier pair on `POST /v1/auth/login/password` (Step 34c).
 *
 * A second class rather than a subclass of the one above, because the difference *is* the
 * decorators: `@ApiProperty` documents the field as required, and only a missing `@IsOptional()`
 * lets the validation pipe accept a body without it - neither can be undone by an inheriting
 * class. So the rules that are not about presence (the type, the empty-string refusal, the
 * ceiling) are stated twice inside one file, adjacently and deliberately, rather than copied into
 * the DTO of one endpoint where a change to one of them could go unremarked.
 */
export class OptionalSubmittedPhoneNumberDto {
  @ApiPropertyOptional({
    description: PHONE_NUMBER_DESCRIPTION,
    example: '024 123 4567',
    maxLength: PHONE_NUMBER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PHONE_NUMBER_MAX_LENGTH)
  phoneNumber?: string;
}
