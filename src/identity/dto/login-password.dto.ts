import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../config/configuration.js';
import { SubmittedPhoneNumberDto } from './phone-number.dto.js';

/**
 * Body of `POST /v1/auth/login/password` (Step 34b): the password sign-in.
 *
 * The number is submitted in the same free format as everywhere else (the field comes from
 * `SubmittedPhoneNumberDto`, and normalization runs on this side too), and the password is
 * carried verbatim - no length floor here, deliberately: a short submission is not a
 * malformed body, it is a *wrong password*, and it has to be answered with the same 401 as
 * a long wrong one rather than with a 400 that tells an attacker the stored password is
 * longer than what they sent. Only the ceiling is enforced, so a body that is really a
 * payload never reaches scrypt.
 */
export class LoginPasswordDto extends SubmittedPhoneNumberDto {
  @ApiProperty({
    description: 'The account password.',
    example: 'correct horse battery staple',
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
