import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../config/configuration.js';

/**
 * Body of `POST /v1/auth/password/change` (Step 34b): set a password when the account has
 * none, change it when it has one.
 *
 * One class for both halves, because they are one decision from the client's side - "here
 * is the password I want" - and the difference is a fact about the *account* rather than
 * about the request. `password` is therefore required and `currentPassword` optional, and
 * the presence rule ("required when a password is already set") is enforced in
 * `PasswordService`, which can read the row; a DTO cannot know it.
 *
 * The length rule is enforced here, at the door, exactly as the PIN's shape is: a password
 * that is too short is a 400 from the validation pipe that never reaches the hasher, and
 * `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH` are read from `configuration.ts` so the rule
 * and the message it carries cannot disagree with the service.
 */
export class ChangePasswordDto {
  @ApiProperty({
    description: `The password to set. At least ${PASSWORD_MIN_LENGTH} characters. Hashed before it is stored, and never returned by any endpoint.`,
    example: 'correct horse battery staple',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  })
  password!: string;

  @ApiPropertyOptional({
    description:
      'The password currently in force, required when the account already has one. Omit it when setting a password for the first time.',
    example: 'correct horse battery staple',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword?: string;
}
