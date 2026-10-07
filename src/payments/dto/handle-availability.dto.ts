import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from '../../identity/handle/handle.js';

/**
 * Query of `GET /v1/handles/availability`: the handle to check.
 *
 * One field, and this class declares only its *type* and its presence - the same split
 * `ChangeHandleDto` makes, for the same reason. Every actual rule about a handle (length,
 * characters, reserved names) lives in `handle.ts` and is applied by `HandlesService`, which
 * answers a 400 naming the rule that broke; the DTO is not a second statement of the policy that
 * could drift from the one `handle.spec.ts` pins.
 *
 * The `@MaxLength` is a ceiling rather than a format rule: 20 characters is comfortably more than
 * the longest legal handle, and - imported rather than restated, so raising the bound stays a
 * one-line change in `handle.ts` - it stops a query string that is really a payload from being
 * walked through `normalizeHandle` character by character.
 */
export class HandleAvailabilityQueryDto {
  @ApiProperty({
    description: `The handle to check. ${HANDLE_MIN_LENGTH}-${HANDLE_MAX_LENGTH} characters: letters, digits and underscores, matched lower-cased. A leading \`@\` is accepted and stripped.`,
    example: 'miriam_owusu',
    maxLength: HANDLE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(HANDLE_MAX_LENGTH)
  handle!: string;
}

/**
 * 200 body of `GET /v1/handles/availability`: whether the caller could claim this handle.
 *
 * The answer carries two fields rather than one, because the endpoint is asked from a form and
 * the form needs to show *what it checked*. `handle` is the canonical form the question was
 * actually about (`@Miriam` comes back as `miriam`), which is the spelling a client can put in
 * the field and in a following request; `available` is the answer about it.
 *
 * ## `available` is `false` only for "another account holds it"
 *
 * A handle that is *malformed* - too short, too long, an illegal character, a reserved name -
 * never reaches this body: it is a 400, in the same words registration would refuse it, so a
 * client can tell "fix the input" (400) from "try another name" (`available: false`) without
 * parsing a message. That is deliberate for reserved names too: they can never be freed, so
 * "taken" would be the wrong tense.
 *
 * The caller's *own* current handle answers `true`: the question this endpoint answers is "could
 * I claim this", and an account re-submitting the name it already holds is exactly the no-op
 * `AuthService.resolveHandle` allows. A second account holding it is the only `false`.
 *
 * ## A courtesy, not a reservation
 *
 * This is an *advisory* read, the same kind of check `resolveHandle` calls a courtesy: two callers
 * can be told `true` for one handle in the same instant, and the unique index on the column is
 * what actually decides when one of them writes it. The endpoint exists so the ordinary case -
 * filling in a name that is already gone - is answered before the form is submitted, not so a
 * client can treat a `true` as a lock.
 */
export class HandleAvailabilityResponseDto {
  @ApiProperty({
    description: 'The canonical (lower-cased, `@`-stripped) handle the answer is about.',
    example: 'miriam_owusu',
  })
  handle!: string;

  @ApiProperty({
    description:
      'Whether the caller could claim this handle right now: `true` when no other account holds it, `false` when one does. The caller’s own handle answers `true`.',
    example: true,
  })
  available!: boolean;
}
