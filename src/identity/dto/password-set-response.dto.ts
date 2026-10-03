import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `POST /v1/auth/password/change` and of `POST /v1/auth/password/reset/confirm`
 * (Step 34b).
 *
 * One field, and it is the same shape the transaction PIN's change answers with: the moment
 * the credential in force was written, which is the fact a security screen shows ("password
 * updated") and the one thing a change cannot report by echoing the password back. It is the
 * write's own instant rather than a column read back - there is no `password_set_at` column
 * and Step 34b adds none - so it reports the fact of the write and not a stored copy of it.
 */
export class PasswordSetResponseDto {
  @ApiProperty({
    description: 'When the password now in force was written.',
    example: '2026-10-03T10:00:00.000Z',
  })
  passwordSetAt!: string;
}
