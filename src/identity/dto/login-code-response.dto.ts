import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `POST /v1/auth/login/otp` (Step 16): a code is on its way.
 *
 * Deliberately the same three fields `RegisterResponseDto` returns for its send,
 * minus the account: this endpoint does not create or change anything, it sends an
 * SMS, and `expiresAt`/`codeLength` are what the code screen needs to render ("6
 * digits, 9:58 left"). The code itself is never in the body - the SMS is its only
 * route to the user, exactly as in registration.
 */
export class LoginCodeResponseDto {
  @ApiProperty({
    description: 'The number the code was sent to, as stored: strict E.164.',
    example: '+233241234567',
  })
  phoneNumber!: string;

  @ApiProperty({
    description: 'When the code stops being accepted.',
    example: '2026-09-26T10:14:12.345Z',
  })
  expiresAt!: string;

  @ApiProperty({
    description: 'How many digits the code has, so the input can be built before it arrives.',
    example: 6,
  })
  codeLength!: number;
}
