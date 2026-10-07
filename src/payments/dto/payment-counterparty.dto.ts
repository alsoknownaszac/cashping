import { ApiProperty } from '@nestjs/swagger';

/**
 * The other account on a payment, as much of it as a history row can name.
 *
 * ## Why this field exists
 *
 * A `transactions` row holds two ids and nothing else, so a client holding one of its own
 * payments could render an amount and a timestamp and no idea *who* the money moved with - the
 * id it would have to resolve (`GET /v1/recipients/:id`) is a round trip per row, which is
 * forty requests to draw a screen of twenty. So the two facts a list actually renders travel
 * with the row: the id, and the handle when the account has one.
 *
 * ## Which account it is
 *
 * The party *other than the caller*: the recipient on a payment the caller sent, the sender on
 * one they received. It is derived from the same `direction` the item carries
 * (`PaymentsService.counterpartyFor`), so a client never has to reason about `senderId` versus
 * `recipientId` itself. A payment the caller sent themselves cannot exist (`POST /v1/payments`
 * refuses it), so the counterparty is always somebody else.
 *
 * ## What it deliberately does not carry
 *
 * No `displayName` and no `verified`, which `RecipientConfirmationResponseDto` does carry. Those
 * are the confirmation screen's fields - read once, just before money moves, from the endpoint
 * whose whole job is to answer "is this the right person". A page of history is a list of things
 * that already happened; the handle is enough to label a row, and `id` is the handle to the
 * screen that asks the full question. Keeping the body to two fields also keeps a page of fifty
 * from carrying fifty display names it will not show.
 */
export class PaymentCounterpartyDto {
  @ApiProperty({
    description:
      'The other account on this payment - the recipient on a `sent` payment, the sender on a `received` one.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  id!: string;

  @ApiProperty({
    description:
      'The counterparty handle, without the leading @. `null` when the account has never claimed one - render [`id`](#/payments/PaymentsController_findOne) as a fallback, or resolve the account through `GET /v1/recipients/:id`.',
    example: 'miriam_owusu',
    nullable: true,
    type: String,
  })
  handle!: string | null;
}
