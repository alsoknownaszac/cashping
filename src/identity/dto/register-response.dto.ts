import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';

/**
 * 201 body of `POST /v1/auth/register`.
 *
 * Deliberately does *not* echo the OTP: the code's only legitimate route to the
 * user is the SMS, and an API response is logged, cached and screenshotted. It
 * does return `codeLength`, so the verification screen can render the right number
 * of inputs without hard-coding the policy.
 */
export class RegisterResponseDto {
  @ApiProperty({
    description: 'Identifies the account created (or reused, if it was pending).',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  userId!: string;

  @ApiProperty({
    description: 'The number as stored: strict E.164, whatever format was submitted.',
    example: '+233241234567',
  })
  phoneNumber!: string;

  @ApiProperty({
    description:
      'Always `PENDING_VERIFICATION` here - a code has been sent, not yet confirmed. Verification (POST /auth/otp/verify) is what makes it `ACTIVE`.',
    enum: UserStatus,
    example: UserStatus.PENDING_VERIFICATION,
  })
  status!: UserStatus;

  @ApiProperty({
    description: 'When the code stops being accepted. Derived from `otp.ttlMinutes`.',
    example: '2026-09-26T10:10:00.000Z',
  })
  expiresAt!: string;

  @ApiProperty({
    description: 'Digits the user has to type, so the UI can render that many inputs.',
    example: 6,
  })
  codeLength!: number;
}
