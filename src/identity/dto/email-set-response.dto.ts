import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `POST /v1/auth/email` (Step 34c): a code is on its way.
 *
 * Deliberately does not echo the code - the email is its only route to the user, exactly as
 * the SMS is for a phone code. `expiresAt` and `codeLength` are what the verification screen
 * needs to render ("6 digits, 9:58 left") without hard-coding the policy.
 *
 * `email` is the *stored* form (trimmed, lower-cased), so a client that submitted
 * `Miriam@Example.com` can show the user what was actually recorded rather than what they
 * typed.
 */
export class EmailSetResponseDto {
  @ApiProperty({
    description: 'The address as stored: trimmed and lower-cased.',
    example: 'miriam@example.com',
  })
  email!: string;

  @ApiProperty({
    description: 'When the code stops being accepted. Derived from `otp.ttlMinutes`.',
    example: '2026-10-03T10:10:00.000Z',
  })
  expiresAt!: string;

  @ApiProperty({
    description: 'Digits the user has to type, so the UI can render that many inputs.',
    example: 6,
  })
  codeLength!: number;
}
