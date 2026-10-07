import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus } from '../../generated/prisma/enums.js';
import { PaymentCounterpartyDto } from './payment-counterparty.dto.js';

/**
 * 200 body of `GET /v1/payments/:id` (Step 30): one payment, as one of its two parties sees it.
 *
 * This is the endpoint `PaymentCreatedResponseDto`'s own docblock points at - "the transaction it
 * may poll" - and the difference between the two bodies is exactly what has happened in between.
 * The creation response can only ever say `PENDING`; this one reports whatever the row now
 * holds (`PROCESSING` while the submission job owns it, then `SUCCESSFUL` or `FAILED`), which is
 * the reason the endpoint exists at all: a client that was told "accepted" needs somewhere to
 * learn what came of it.
 *
 * ## `direction` is read from the row, not from the request
 *
 * The same payment is a `sent` payment to its sender and a `received` one to its recipient, and
 * both callers reach this route with the same id. `direction` is derived per caller
 * (`directionFor`), because a client rendering "you sent" or "you received" cannot derive it: the
 * id it holds is the only thing it knows.
 *
 * ## The two fields that are only here
 *
 * `failureReason` and `stellarTxHash` are on this body and deliberately **not** on
 * `PaymentListItemDto`:
 *
 * - `failureReason` is the raw machine code the submission path wrote
 *   (`landed-unsuccessful:tx_failed`, `submission-rejected:tx_bad_auth`, and so on - see
 *   `submission-triage.ts`). It is not a sentence and must not be rendered as one: the phrasing
 *   belongs to the client, which knows what the person is looking at. It is `null` unless the
 *   status is `FAILED`, and `null` stays `null` rather than being omitted, so a client can switch
 *   on presence without a `'failureReason' in body` check.
 * - `stellarTxHash` is the value a person pastes into an explorer to see the money for
 *   themselves. It exists from the moment a signed transaction was built, which is why it can be
 *   present on a row that is still `PROCESSING` or even `FAILED` - and why it is `null` for a
 *   payment nothing has been built for yet.
 *
 * A list of fifty rows does not need either, and omitting them keeps a page of history to the
 * fields a list actually sorts and renders. That is a disclosure decision as well as a size one:
 * the fewer rows that carry a machine reason, the fewer places it can be shown as if it were
 * written for a person.
 *
 * ## `counterparty`: the same two fields on both bodies
 *
 * `counterparty` is the one field shared with `PaymentListItemDto` rather than being exclusive to
 * one of them, because the detail screen and the list label the person the same way. See
 * `PaymentCounterpartyDto` for why it carries an id and a handle and nothing richer.
 */
export class PaymentResponseDto {
  @ApiProperty({
    description: 'The transaction id, exactly as it was returned when the payment was created.',
    example: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
  })
  id!: string;

  @ApiProperty({
    description: [
      'Where the payment got to. `PENDING` - created, nothing submitted yet; `PROCESSING` - a signed transaction exists and the network has not answered; `SUCCESSFUL` - a ledger closed it; `FAILED` - it will not move, and `failureReason` says why.',
      '',
      '`SUCCESSFUL` and `FAILED` are final. The ledger does not un-close a transaction, so nothing in this API moves a payment out of either.',
    ].join('\n'),
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
      'Which side of this payment the caller is on: `sent` when the caller is the sender, `received` when the caller is the recipient. The same payment answers `sent` to one account and `received` to the other.',
    enum: ['sent', 'received'],
    example: 'sent',
  })
  direction!: 'sent' | 'received';

  @ApiProperty({
    description:
      'The account being paid. On a `received` payment this is the caller, and the account that sent it is the caller of the `sent` view of the same id.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  recipientId!: string;

  @ApiProperty({
    description:
      'The party other than the caller - the recipient on a `sent` payment, the sender on a `received` one.',
    type: PaymentCounterpartyDto,
  })
  counterparty!: PaymentCounterpartyDto;

  @ApiProperty({
    description: 'When the row was written, as an ISO-8601 instant. The value history is ordered by.',
    example: '2026-09-29T16:53:53.412Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: [
      'Why the payment failed, as the machine code the submission path recorded - or `null`.',
      '',
      '`landed-unsuccessful:<code>` means a ledger closed the transaction unsuccessfully (the fee is charged and the sequence consumed, which is why a `FAILED` row\'s `stellarTxHash` is worth asking Horizon about rather than assuming absent). `submission-rejected:<code>` means the transaction was refused and was never in a ledger. `secret-envelope:<code>` answers a signing failure. An unrecognised code carries no prefix at all.',
      '',
      'Never Horizon\'s prose: an error body is unbounded and carries URLs, and this value is stored and may be shown. Render it with your own sentence, or not at all.',
    ].join('\n'),
    nullable: true,
    type: String,
    example: null,
  })
  failureReason!: string | null;

  @ApiProperty({
    description:
      'The hash of the signed Stellar transaction this payment carries, or `null` if none has been built yet. Paste it into an explorer to see the transaction for yourself.',
    nullable: true,
    type: String,
    example: 'e9da1c48bdfaeacd13eb05d1fff82eee4d61d77f0faa467c9d539955bf36ec0d',
  })
  stellarTxHash!: string | null;
}
