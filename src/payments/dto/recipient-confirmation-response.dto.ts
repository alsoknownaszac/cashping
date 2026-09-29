import { ApiProperty } from '@nestjs/swagger';

/**
 * 200 body of `GET /v1/recipients/:id` (Step 22): the confirmation payload.
 *
 * What the frontend's recipient-confirmation screen shows before money moves, and nothing
 * beyond it: who the person is (`handle`, `displayName`), that their identity is verified, and
 * the id the request was about. No phone number (see `RecipientSearchResultDto` - this is the
 * same rule, and a confirmation screen is not a place to start disclosing what search will not
 * hand over), no Stellar keys, no timestamps, no status history.
 *
 * `verified` is the identity indicator the screen renders: `true` means the phone number behind
 * the account was proven (Step 14). Every response has it `true` *by construction*, because
 * `RecipientsService` only answers for `ACTIVE` accounts - an unverified or suspended account is
 * a 404, exactly like an id that does not exist, and the two are deliberately not distinguished
 * (a lookup that says "this id exists but is suspended" is an oracle with no purpose here).
 *
 * Keeping the field rather than dropping it is deliberate: the screen's job is to show that the
 * person was verified, and the day a second verification tier exists (KYC), this field is where
 * the answer changes - a client that renders `verified` today needs no rewrite then.
 */
export class RecipientConfirmationResponseDto {
  @ApiProperty({
    description: 'The recipient, as the id in the request named them.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  id!: string;

  @ApiProperty({
    description:
      'The handle, without the leading @. `null` when the account has never claimed one.',
    example: 'miriam_owusu',
    nullable: true,
    type: String,
  })
  handle!: string | null;

  @ApiProperty({
    description:
      'The name to show on the confirmation screen. `null` until a profile endpoint sets one.',
    example: 'Miriam Owusu',
    nullable: true,
    type: String,
  })
  displayName!: string | null;

  @ApiProperty({
    description:
      'Whether the identity behind this account is verified. `true` for every recipient this endpoint returns: an unverified account cannot receive money and answers 404.',
    example: true,
  })
  verified!: boolean;
}
