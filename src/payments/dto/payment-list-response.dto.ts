import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus } from '../../generated/prisma/enums.js';

/**
 * One payment in a page of history.
 *
 * The fields a list sorts and renders, and no more: the two fields that only make sense while
 * looking at one payment (`failureReason`, `stellarTxHash`) are on `PaymentResponseDto` and
 * deliberately absent here - see that DTO's docblock for the argument, which is a disclosure one
 * as much as a size one.
 *
 * `recipientId` is the only party on the row, and on a `received` item it is the caller. It is
 * here rather than a "counterparty" field because the id is what the row holds: the account a
 * caller wants to name on the screen (the person they paid, or the person who paid them) is
 * resolved through `GET /v1/recipients/:id`, which is the directory's job and not history's.
 */
export class PaymentListItemDto {
  @ApiProperty({
    description: 'The transaction id - pass it to `GET /v1/payments/:id` for the whole row.',
    example: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
  })
  id!: string;

  @ApiProperty({
    description: 'Where the payment got to. `SUCCESSFUL` and `FAILED` are final.',
    enum: Object.values(TransactionStatus),
    example: 'SUCCESSFUL',
  })
  status!: TransactionStatus;

  @ApiProperty({
    description: 'The amount **as stored**, as a decimal string (7 decimals at most).',
    example: '25.5',
    type: String,
  })
  amount!: string;

  @ApiProperty({
    description:
      'Which side of this payment the caller is on for this item: `sent` when the caller paid it out, `received` when it was paid to them.',
    enum: ['sent', 'received'],
    example: 'sent',
  })
  direction!: 'sent' | 'received';

  @ApiProperty({
    description:
      'The account being paid. Equal to the caller on a `received` item.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  recipientId!: string;

  @ApiProperty({
    description: 'When the row was written, as an ISO-8601 instant. The order of the list.',
    example: '2026-09-29T16:53:53.412Z',
  })
  createdAt!: string;
}

/**
 * 200 body of `GET /v1/payments` (Step 30): one page of the caller's history, newest first.
 *
 * `hasMore` is the reason `limit` is honest. It is computed from a `limit + 1` read rather than a
 * second `count()`, so it cannot disagree with the page the client is holding: `items.length ===
 * limit && hasMore` means "there are more, ask for a bigger page". The order is `createdAt`
 * descending with the id as a tiebreak, so two rows written in the same millisecond still arrive in
 * one stable order - see `PAYMENT_HISTORY_ORDER` for why that matters to a client that is paging.
 *
 * The list is scoped to the caller by membership, never by a parameter: `items` can only ever hold
 * payments the caller sent or received, and a filter can only narrow that - it can never widen it.
 */
export class PaymentListResponseDto {
  @ApiProperty({
    description: 'The payments that matched, newest first.',
    type: [PaymentListItemDto],
  })
  items!: PaymentListItemDto[];

  @ApiProperty({
    description:
      'Whether more payments matched than this page holds. `false` means the filter (or the account) has been read to the end.',
    example: false,
  })
  hasMore!: boolean;
}
