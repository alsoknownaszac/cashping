import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * A phone number as submitted, and the the one definition of what that means
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
 */
export class SubmittedPhoneNumberDto {
  @ApiProperty({
    description:
      'The phone number, in any reasonable format: local (024 123 4567), international with a plus (+233241234567), with the national prefix (+2330241234567) or with 00 (00233241234567). Stored and matched as E.164.',
    example: '024 123 4567',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  // A ceiling, not a format rule: 32 characters is comfortably more than the
  // longest way any of the accepted formats writes a 15-digit number, and it
  // stops a body that is really a payload from being walked character by
  // character through the phone number parser.
  //
  // Validation that number-shaped text is not a `phoneNumber` is deliberately not
  // done here either: a regex in a decorator is the hand-rolled phone parsing
  // Step 9 exists to replace.
  @MaxLength(32)
  phoneNumber!: string;
}
