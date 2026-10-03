import { ApiProperty } from '@nestjs/swagger';
import { STEP_UP_TOKEN_TTL_MINUTES } from '../../config/configuration.js';

/**
 * 200 body of `POST /v1/auth/pin/verify` (Step 34a).
 *
 * A step-up token, and when it stops being accepted - nothing else. It is deliberately
 * not a session: it is a second, narrower credential that says "the PIN was proved
 * seconds ago", which is what `StepUpAuthGuard` accepts on `POST /v1/payments`. It
 * expires in minutes rather than days, and it cannot renew itself - the way to get
 * another one is to prove the PIN again.
 *
 * The response never contains the PIN, and it never says how many attempts were left:
 * a successful call has no attempts left to report, and the failure path is where that
 * number belongs.
 */
export class PinVerifyResponseDto {
  @ApiProperty({
    description:
      'Proof that the PIN was given, to be sent as `X-Step-Up-Token` on `POST /v1/payments`.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  stepUpToken!: string;

  @ApiProperty({
    description: `When the step-up token stops being accepted. Derived from \`pin.stepUpTokenTtlMinutes\` (${STEP_UP_TOKEN_TTL_MINUTES} minutes).`,
    example: '2026-10-02T10:05:00.000Z',
  })
  stepUpTokenExpiresAt!: string;
}
