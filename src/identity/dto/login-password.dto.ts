import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../config/configuration.js';
import { MAX_EMAIL_LENGTH } from '../email/email-address.js';
import { OptionalSubmittedPhoneNumberDto } from './phone-number.dto.js';

/**
 * Body of `POST /v1/auth/login/password` (Steps 34b and 34c): the password sign-in, with either
 * identifier the account has.
 *
 * Two fields carry the identity, and *exactly one* of them is present: the number the account
 * registered with, or the address it has verified (Step 34c). That rule is enforced in
 * `AuthService` rather than here, for the reason `ChangePasswordDto` gives about
 * `currentPassword` - a request-shape rule whose answer is a *sentence* about the whole body, and
 * only the service can write one that names both fields.
 *
 * The number is submitted in the same free format as everywhere else (the field comes from
 * `OptionalSubmittedPhoneNumberDto`, so `POST /auth/register` and this endpoint share its rules),
 * and the address in the shape `POST /auth/email` stores. Normalization runs on this side too, in
 * the service, so the value looked up is the value the column holds.
 *
 * The password is carried verbatim - no length floor here, deliberately: a short submission is
 * not a malformed body, it is a *wrong password*, and it has to be answered with the same 401 as
 * a long wrong one rather than with a 400 that tells an attacker the stored password is
 * longer than what they sent. Only the ceiling is enforced, so a body that is really a
 * payload never reaches scrypt.
 */
export class LoginPasswordDto extends OptionalSubmittedPhoneNumberDto {
  @ApiPropertyOptional({
    description: `The verified email address on the account, as an alternative to \`phoneNumber\`. An address that was attached but never verified is not a sign-in credential. Provide this or \`phoneNumber\`, not both. At most ${MAX_EMAIL_LENGTH} characters.`,
    example: 'miriam@example.com',
    maxLength: MAX_EMAIL_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_EMAIL_LENGTH)
  email?: string;

  @ApiProperty({
    description: 'The account password.',
    example: 'correct horse battery staple',
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
