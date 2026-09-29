import { ApiProperty } from '@nestjs/swagger';

/**
 * The 202 body of `POST /v1/payments` (Step 25): what was written, and nothing about the
 * network yet.
 *
 * `id` is the value the client needs - the transaction it may poll (`GET /v1/payments/:id`,
 * Step 30) and the one Day 4 submits - and the rest is what lets a screen render the row it
 * just created without a second request. `status` is always `PENDING` from this endpoint: a
 * row this step writes has not been offered to Stellar, so any other value would be a lie the
 * client could not tell apart from a real state change (see `TransactionStatus`).
 *
 * Deliberately absent: the recipient's handle and display name (the client confirmed them a
 * request earlier and has them on screen), the fee (nobody has decided one - the module
 * docblock in `amount.ts` records that), and any Horizon or submission detail (there is none
 * yet; Steps 27-29 add it to the *transaction* endpoint, not to this one).
 *
 * `amount` is the amount **as stored**, re-read from the row rather than echoed from the
 * request: the response then proves the round trip through `numeric(20, 7)` - the same claim
 * `test/money.e2e-spec.ts` makes directly - and cannot disagree with what the database holds.
 */
export class PaymentCreatedResponseDto {
  @ApiProperty({
    description: 'The transaction id - the value to poll and to reference in support.',
    example: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
  })
  id!: string;

  @ApiProperty({
    description: [
      'Where the payment is. `PENDING` is the only value this endpoint can produce: the row exists and its amount is reserved against the sender, and nothing has been submitted to Stellar yet.',
      '',
      '`PROCESSING`, `SUCCESSFUL` and `FAILED` arrive with Day 4 (Steps 27-29) and are listed here because a client that switches on this field should know the whole set it can later see.',
    ].join('\n'),
    enum: ['PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED'],
    example: 'PENDING',
  })
  status!: 'PENDING' | 'PROCESSING' | 'SUCCESSFUL' | 'FAILED';

  @ApiProperty({
    description: 'The amount as it was stored, as a decimal string (7 decimals at most).',
    example: '25.5',
    type: String,
  })
  amount!: string;

  @ApiProperty({
    description:
      'The account being paid, echoed so the client can match the response to the confirmation screen.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  recipientId!: string;

  @ApiProperty({
    description: 'When the row was written, as an ISO-8601 instant.',
    example: '2026-09-29T16:53:53.412Z',
  })
  createdAt!: string;
}
