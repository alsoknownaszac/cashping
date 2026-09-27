import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';

/**
 * 200 body of `GET /v1/auth/session` (Step 16): who this access token belongs to.
 *
 * The endpoint a client calls on every launch with the access token it has stored.
 * It is also the only way to read the signed-in user's own profile, which is the
 * point: nothing about the user is trusted from the token's claims, and what comes
 * back is the row as it is *now*, not as it was when the token was signed. A handle
 * changed on another device shows up here immediately.
 *
 * `status` is part of the body rather than an assumption, because a session whose
 * account is `SUSPENDED` is refused by the guard with a 403 - so a 200 here means the
 * account is usable, and the client can read that off the field instead of inferring
 * it from the status code.
 */
export class SessionResponseDto {
  @ApiProperty({
    description: 'The signed-in account.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  userId!: string;

  @ApiProperty({
    description: 'The signed-in number, as stored: strict E.164.',
    example: '+233241234567',
  })
  phoneNumber!: string;

  @ApiProperty({
    description: '`ACTIVE` for any account whose token is accepted.',
    enum: UserStatus,
    example: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  @ApiProperty({
    description: 'The claimed handle, or `null` if none was claimed at registration.',
    example: 'miriam_owusu',
    nullable: true,
    type: String,
  })
  handle!: string | null;
}
