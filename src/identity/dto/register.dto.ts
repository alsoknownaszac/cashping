import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /v1/auth/register` (Step 10).
 *
 * `phoneNumber` is the *raw* submission, not E.164: the endpoint's contract is
 * "any reasonable format", and `configuration.ts`'s `phone.defaultRegion` decides
 * how a local spelling is read. The normalizer (Step 9) runs before anything
 * touches the database, so the DTO's only job is to establish that a non-empty
 * string arrived - validation that number-shaped text is not a `phoneNumber` is
 * *not* done here, because a regex in a decorator is exactly the hand-rolled
 * phone parsing Step 9 exists to replace.
 */
export class RegisterDto {
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
  @MaxLength(32)
  phoneNumber!: string;
}
