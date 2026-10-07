import { ApiProperty } from '@nestjs/swagger';

/**
 * The other account on a payment, as much of it as a history row can name.
 *
 * ## Why this field exists
 *
 * A `transactions` row holds two ids and nothing else, so a client holding one of its own
 * payments could render an amount and a timestamp and no idea *who* the money moved with - the
 * id it would have to resolve (`GET /v1/recipients/:id`) is a round trip per row, which is
 * forty requests to draw a screen of twenty. So the facts a list actually renders travel with
 * the row: the id, the handle and the display name, all three read from the one `users` row each
 * side of the join already names.
 *
 * ## Which account it is
 *
 * The party *other than the caller*: the recipient on a payment the caller sent, the sender on
 * one they received. It is derived from the same `direction` the item carries
 * (`PaymentsService.counterpartyFor`), so a client never has to reason about `senderId` versus
 * `recipientId` itself. A payment the caller sent themselves cannot exist (`POST /v1/payments`
 * refuses it), so the counterparty is always somebody else.
 *
 * ## The three fields, and why they are nullable
 *
 * `handle` and `displayName` are both optional columns on `users`: an account can exist, hold a
 * phone number and move money without having claimed either, which is the normal state during
 * onboarding. Both therefore travel as `null` rather than being dropped or defaulted to the id -
 * a client decides what to render, and `'displayName' in body` never has to be asked. A client
 * that wants a name renders `displayName ?? handle ?? id`, in that order, because a person who
 * gave a display name gave it to be shown.
 *
 * ## What it deliberately does not carry
 *
 * No `verified` (which `RecipientConfirmationResponseDto` does carry), and no contact details of
 * any kind: no phone number, no email, masked or otherwise. Those belong to the one screen that
 * asks "is this the right person" just before money moves, which is read once and on purpose -
 * a page of history is a list of things that already happened, and every row of it repeating a
 * number you already sent money to is disclosure with nothing on the screen asking for it. The
 * `id` is what a client follows to that fuller screen for the one row it wants to act on.
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

  @ApiProperty({
    description:
      'The name the counterparty gave to be shown, or `null` if they never set one. Render `displayName ?? handle ?? id` - the display name is the one the account chose, the handle is what it can still be paid by, and the id is always there.',
    example: 'Miriam Owusu',
    nullable: true,
    type: String,
  })
  displayName!: string | null;
}
