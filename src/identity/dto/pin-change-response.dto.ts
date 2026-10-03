import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `POST /v1/auth/pin/change` (Step 34a).
 *
 * One field, and it is the timestamp of the write rather than anything derived from it:
 * the response says *when* the PIN in force was installed, which is the fact a client
 * shows on a security screen ("PIN updated") and the one thing a change cannot report by
 * echoing the PIN back. `null` never appears here - a 200 means a PIN is set.
 */
export class PinChangeResponseDto {
  @ApiProperty({
    description: 'When the PIN now in force was written.',
    example: '2026-10-02T10:00:00.000Z',
  })
  pinSetAt!: string;
}
