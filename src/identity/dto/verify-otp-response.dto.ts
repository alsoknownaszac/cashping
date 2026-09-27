import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';
import { TokenPairResponseDto } from './token-pair-response.dto.js';

/**
 * 200 body of `POST /v1/auth/otp/verify` (Step 14, extended in Step 16).
 *
 * `phoneVerifiedAt` is the field this whole day exists to produce: Day 2's
 * Stellar account provisioning triggers off it, so it is returned here rather
 * than only being visible in the database.
 *
 * The token pair (Step 16) comes with it because verification is the moment the
 * account becomes usable, and the alternative is the worst version of this flow: the
 * user proves their number and is then asked for a *second* code - another SMS, at
 * real cost, to answer a question the first one already answered. Signing in is what
 * a verified account does next, so the session is handed over here and
 * `POST /auth/login` exists for the *later* launches where no such code has just been
 * spent.
 */
export class VerifyOtpResponseDto extends TokenPairResponseDto {
  @ApiProperty({
    description: 'The account that was just verified.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  userId!: string;

  @ApiProperty({
    description: 'The verified number, as stored: strict E.164.',
    example: '+233241234567',
  })
  phoneNumber!: string;

  @ApiProperty({
    description: '`ACTIVE` once the number is proven.',
    enum: UserStatus,
    example: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  @ApiProperty({
    description:
      'When the number was verified. This is the hand-off point to Day 2 (Stellar account provisioning).',
    example: '2026-09-26T10:04:12.345Z',
  })
  phoneVerifiedAt!: string;
}
