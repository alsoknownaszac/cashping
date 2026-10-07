import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from '../handle/handle.js';

/**
 * Body of `PATCH /v1/auth/handle` (the "handle change" endpoint).
 *
 * One field, and this class deliberately declares only its *type* and its presence. Every
 * rule about what a handle actually is - length, characters, reserved names - lives in
 * `handle.ts`, and the availability check needs the database, which no DTO can read. So a
 * malformed handle is refused by `AuthService.resolveHandle` (a 400 naming the rule that
 * broke), not here, and a handler is never a second statement of the policy that could
 * drift from the one `handle.spec.ts` pins.
 *
 * The `@MaxLength` is a ceiling rather than a format rule, exactly as `phone-number.dto.ts`
 * uses one: 20 characters is comfortably more than the longest legal handle, and it stops a
 * body that is really a payload from being walked character by character through
 * `normalizeHandle`. It is the policy maximum, imported rather than restated, so raising the
 * bound stays a one-line change in `handle.ts`. The description names `HANDLE_MIN_LENGTH`
 * for the same reason: the two numbers a client renders in a field hint come from the module
 * that owns them.
 */
export class ChangeHandleDto {
  @ApiProperty({
    description: `The handle to claim. ${HANDLE_MIN_LENGTH}-${HANDLE_MAX_LENGTH} characters: letters, digits and underscores, stored and matched lower-cased. A leading \`@\` is accepted and stripped.`,
    example: 'miriam_owusu',
    maxLength: HANDLE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(HANDLE_MAX_LENGTH)
  handle!: string;
}
