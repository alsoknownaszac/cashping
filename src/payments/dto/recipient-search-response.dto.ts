import { ApiProperty } from '@nestjs/swagger';

/**
 * One recipient, as a search may describe them.
 *
 * ## Why there is no `phoneNumber` in this DTO - read this before adding one
 *
 * This is Step 21's privacy decision, stated here so that a later change cannot miss it:
 * **a recipient search never returns a phone number.** The search is a *directory* lookup -
 * `q` may be a handle prefix, so a caller can list people they have never interacted with - and
 * a response carrying the number behind each row would turn "who is called mir…" into "give me
 * the phone numbers of everyone whose handle starts with m". That is an address-book harvest
 * in twenty requests, and it is a worse outcome than the enumeration the rate limit already
 * struggles with, because it hands over numbers that *are* registered rather than answering
 * yes/no about numbers that might be.
 *
 * The number is therefore disclosed only to a caller who already *typed* it (the exact-match
 * path), and even there it is not echoed back, because the client supplied it and has it on
 * screen: the phone path returns this same object, with `handle` and `displayName` as they are
 * - possibly both null for an account that never claimed a handle. The client renders it with
 * the number it searched for, which is the only context in which "someone with no handle" is
 * still an identifiable person.
 *
 * Adding `phoneNumber` (or `status`, or `createdAt`) to this DTO is a re-litigation of that
 * decision, not a small field addition - and confirming it does not appear in a response body
 * is the first line of Step 21's audit.
 */
export class RecipientSearchResultDto {
  @ApiProperty({
    description:
      "The recipient's account id - the value `GET /v1/recipients/:id` takes, so a client confirms with this id rather than by re-typing what it searched with.",
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  id!: string;

  @ApiProperty({
    description:
      'The handle, without the leading @, as stored (lower case). `null` when the account has never claimed one - reachable only on the phone path, since the handle path matches handles.',
    example: 'miriam_owusu',
    nullable: true,
    type: String,
  })
  handle!: string | null;

  @ApiProperty({
    description:
      'The name the account is shown by. `null` until a profile endpoint sets one; the client falls back to the handle, or - on the phone path - to the number it searched for.',
    example: 'Miriam Owusu',
    nullable: true,
    type: String,
  })
  displayName!: string | null;
}

/**
 * 200 body of `GET /v1/recipients/search` (Step 21).
 *
 * `matchedBy` says which reading of `q` produced these results, and it is not decoration: an
 * empty `results` array means "that number is not on Cashping" (`matchedBy: 'phone'`) or "no
 * handle starts with that" (`matchedBy: 'handle'`), and a client that cannot tell them apart
 * has to say something vague about both. It is also the honest label on the one thing this
 * endpoint can be abused for - the phone path is a membership oracle, priced by the rate
 * limit rather than hidden.
 *
 * `hasMore` exists because `limit` is a cap and a cap reported as a complete answer is a lie:
 * `results.length === limit && hasMore` means "there are more, ask for fewer characters".
 */
export class RecipientSearchResponseDto {
  @ApiProperty({
    description:
      '`phone` when `q` was read as an E.164 number and matched exactly (at most one result), `handle` when it was read as a handle prefix.',
    enum: ['phone', 'handle'],
    example: 'handle',
  })
  matchedBy!: 'phone' | 'handle';

  @ApiProperty({
    description:
      'The recipients that matched, ordered by handle. Never the caller: this is a list of people to pay.',
    type: [RecipientSearchResultDto],
  })
  results!: RecipientSearchResultDto[];

  @ApiProperty({
    description:
      'Whether more handles match than were returned. Always `false` on the phone path, which cannot match more than one account.',
    example: false,
  })
  hasMore!: boolean;
}
