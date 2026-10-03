import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `POST /v1/auth/email/verify` (Step 34c): the address is confirmed.
 *
 * The address and the moment it was proved, and nothing else. The address is repeated here
 * - even though the client just sent the code for it - so the caller has the confirmed value
 * in hand for the screen that says "email confirmed", rather than relying on what it thinks
 * it set earlier.
 */
export class EmailVerifyResponseDto {
  @ApiProperty({
    description: 'The address that was confirmed, as stored.',
    example: 'miriam@example.com',
  })
  email!: string;

  @ApiProperty({
    description: 'When the address was proved. This is the instant a receipt may be sent to it.',
    example: '2026-10-03T10:05:00.000Z',
  })
  emailVerifiedAt!: string;
}
