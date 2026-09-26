import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';

/**
 * 200 body of `POST /v1/auth/otp/verify`.
 *
 * `phoneVerifiedAt` is the field this whole day exists to produce: Day 2's
 * Stellar account provisioning triggers off it, so it is returned here rather
 * than only being visible in the database.
 */
export class VerifyOtpResponseDto {
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
