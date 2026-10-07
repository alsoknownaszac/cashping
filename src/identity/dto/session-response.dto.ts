import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../generated/prisma/enums.js';

/**
 * How far past sign-in a user has got, so the client can pick the next screen.
 *
 * A session and a set-up account are two different things, and the launch flow has to tell them
 * apart: an account can be `ACTIVE` - its phone number proved - and still have no wallet, no
 * transaction PIN, no password and no email. Each field is one onboarding step the app can send the
 * user to, and all six are read fresh; none is in the access token, which carries only the user id.
 * Every one of them is a boolean about a credential or a verification, never the credential: this
 * block is safe to log, cache and show, which is the point of answering "has one?" rather than
 * "which one?".
 *
 * `hasEmail` and `emailVerified` are deliberately two fields rather than one: an address is
 * *attached* by `POST /auth/email` and only becomes a credential once a code proves it, so a
 * screen offering "add an email" has to behave differently from one offering "confirm it".
 *
 * Declared before `SessionResponseDto`, which names it as a property type.
 */
export class SessionOnboardingDto {
  @ApiProperty({
    description:
      'Whether the account has a Stellar wallet. `false` after a provisioning that did not finish, which the client can retry.',
    example: true,
  })
  hasWallet!: boolean;

  @ApiProperty({
    description:
      'Whether a transaction PIN is set. `false` for an account that has never set one, including a Google-SSO account (Step 34d) before it chooses one.',
    example: true,
  })
  hasPin!: boolean;

  @ApiProperty({
    description:
      'Whether a password is set. `false` for a Google-SSO account (Step 34d) and for an OTP-only account that never went on to set one - the two cases a "create a password" screen is for. Whether one exists, never what it is.',
    example: false,
  })
  hasPassword!: boolean;

  @ApiProperty({
    description: 'Whether an email address is attached, whether or not a code has proved it.',
    example: true,
  })
  hasEmail!: boolean;

  @ApiProperty({
    description:
      'Whether the attached email has been proved by a code. Always `false` when `hasEmail` is `false`.',
    example: true,
  })
  emailVerified!: boolean;

  @ApiProperty({
    description:
      'Whether the phone number behind the account was proved. `true` for every session this endpoint answers for.',
    example: true,
  })
  phoneVerified!: boolean;
}

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

  @ApiProperty({
    description: 'How far the account is through onboarding - what the client shows next.',
    type: SessionOnboardingDto,
  })
  onboarding!: SessionOnboardingDto;
}

